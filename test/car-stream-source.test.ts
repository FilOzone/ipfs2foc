/**
 * `ipfs2foc-core/car-stream-source`: one streaming CAR request per root,
 * indexed and served block-by-block, with verified gap-fill.
 *
 * The exporter (`car-export.ts`) is already pinned byte-identical to the
 * gateway CAR (`car-export-byte-identity.test.ts`); its output depends only on
 * the bytes its `BlockSource` returns per CID, never on how they were fetched.
 * So these prove the one property the new source must hold: it returns the
 * correct bytes for every block the exporter asks for, stays loud on a gap it
 * cannot fill, and never deadlocks — feeding it through the exporter then
 * reproduces the canonical CAR exactly.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { CarReader } from '@ipld/car'
import { MemoryBlockstore } from 'blockstore-core'
import { importBytes, importer } from 'ipfs-unixfs-importer'
import { exportCanonicalCar } from 'ipfs2foc-core/car-export'
import { CarStreamSource, defaultGetCodec } from 'ipfs2foc-core/car-stream-source'
import { CID } from 'multiformats/cid'

const sha = (u8: Uint8Array) => createHash('sha256').update(u8).digest('hex')

async function concat(iter: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of iter) {
    chunks.push(chunk)
    total += chunk.length
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** deterministic bytes without Math.random */
function payload(n: number, seed = 0x2545f491): Uint8Array {
  const u8 = new Uint8Array(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    u8[i] = x & 0xff
  }
  return u8
}

interface Block {
  cid: CID
  bytes: Uint8Array
}

/** The canonical CAR's blocks, in the exact order the exporter emits them. */
async function canonicalBlocks(blockstore: MemoryBlockstore, root: CID): Promise<Block[]> {
  const carBytes = await concat(exportCanonicalCar(blockstore, defaultGetCodec, root))
  const reader = await CarReader.fromBytes(carBytes)
  const blocks: Block[] = []
  for await (const b of reader.blocks()) blocks.push({ cid: b.cid as unknown as CID, bytes: b.bytes })
  return blocks
}

/** An `openCarStream` that replays a fixed block list, optionally transformed. */
function replay(blocks: Block[], transform: (b: Block) => Block | null = (b) => b) {
  return async function* (_root: CID, _signal?: AbortSignal): AsyncIterable<Block> {
    for (const b of blocks) {
      const t = transform(b)
      if (t != null) yield t
    }
  }
}

async function sharded(): Promise<{ blockstore: MemoryBlockstore; root: CID; blocks: Block[] }> {
  const blockstore = new MemoryBlockstore()
  let last: { cid: { toString(): string } } | undefined
  const entries = Array.from({ length: 64 }, (_, i) => ({ path: `dir/file-${i}.bin`, content: payload(160, i + 1) }))
  for await (const entry of importer(entries, blockstore, { wrapWithDirectory: true, shardSplitThresholdBytes: 256 })) {
    last = entry
  }
  const root = CID.parse(last?.cid.toString() ?? '')
  return { blockstore, root, blocks: await canonicalBlocks(blockstore, root) }
}

test('through the exporter, a replayed CAR stream reproduces the canonical bytes', async () => {
  const { blockstore, root, blocks } = await sharded()
  let opens = 0
  const reference = await concat(exportCanonicalCar(blockstore, defaultGetCodec, root))

  const source = new CarStreamSource('https://gw.example', {
    openCarStream: (r, s) => {
      opens++
      return replay(blocks)(r, s)
    },
    fetchRawBlock: () => {
      throw new Error('should not gap-fill a complete stream')
    },
  })
  const streamed = await concat(exportCanonicalCar(source, defaultGetCodec, root))
  source.close()

  assert.equal(sha(streamed), sha(reference))
  assert.equal(opens, 1, 'exactly one CAR request per root')
})

test('concurrent gets for different blocks share a single stream', async () => {
  const { root, blocks } = await sharded()
  let opens = 0
  const source = new CarStreamSource('https://gw.example', {
    openCarStream: (r, s) => {
      opens++
      return replay(blocks)(r, s)
    },
  })
  // Ask for root first (so the stream starts), then a spread of blocks at once.
  const rootBytes = await source.get(root)
  const wanted = [blocks[1], blocks[Math.floor(blocks.length / 2)], blocks[blocks.length - 1]]
  const got = await Promise.all(wanted.map((b) => source.get(b.cid)))
  source.close()

  assert.equal(sha(rootBytes), sha(blocks[0].bytes))
  for (let i = 0; i < wanted.length; i++) assert.equal(sha(got[i]), sha(wanted[i].bytes))
  assert.equal(opens, 1)
})

test('a block missing from the CAR stream is gap-filled by a single raw fetch', async () => {
  const { blockstore, root, blocks } = await sharded()
  const omitted = blocks[Math.floor(blocks.length / 2)]
  const rawFetched: string[] = []

  const source = new CarStreamSource('https://gw.example', {
    openCarStream: replay(blocks, (b) => (b.cid.equals(omitted.cid) ? null : b)),
    fetchRawBlock: async (cid) => {
      rawFetched.push(cid.toString())
      const found = blocks.find((b) => b.cid.equals(cid))
      if (found == null) throw new Error(`raw fetch has no block for ${cid}`)
      return found.bytes
    },
  })
  const reference = await concat(exportCanonicalCar(blockstore, defaultGetCodec, root))
  const streamed = await concat(exportCanonicalCar(source, defaultGetCodec, root))
  source.close()

  assert.equal(sha(streamed), sha(reference))
  assert.deepEqual(rawFetched, [omitted.cid.toString()], 'gap-filled exactly the omitted block, once')
})

test('a corrupt CAR block is dropped and recovered via verified gap-fill', async () => {
  const { blockstore, root, blocks } = await sharded()
  const target = blocks[blocks.length - 1]
  const corrupt = (b: Block): Block => {
    if (!b.cid.equals(target.cid)) return b
    const bad = b.bytes.slice()
    bad[0] ^= 0xff
    return { cid: b.cid, bytes: bad }
  }
  let rawCalls = 0

  const source = new CarStreamSource('https://gw.example', {
    openCarStream: replay(blocks, corrupt),
    fetchRawBlock: async (cid) => {
      rawCalls++
      return blocks.find((b) => b.cid.equals(cid))?.bytes ?? new Uint8Array()
    },
  })
  const reference = await concat(exportCanonicalCar(blockstore, defaultGetCodec, root))
  const streamed = await concat(exportCanonicalCar(source, defaultGetCodec, root))
  source.close()

  assert.equal(sha(streamed), sha(reference))
  assert.equal(rawCalls, 1, 'only the corrupt block fell through to gap-fill')
})

test('a gap the raw fetch cannot fill rejects loudly, never truncates', async () => {
  const { blockstore: _bs, root, blocks } = await sharded()
  const omitted = blocks[Math.floor(blocks.length / 2)]
  const source = new CarStreamSource('https://gw.example', {
    openCarStream: replay(blocks, (b) => (b.cid.equals(omitted.cid) ? null : b)),
    fetchRawBlock: async () => {
      throw new Error('received 504 Gateway Timeout')
    },
  })
  await assert.rejects(concat(exportCanonicalCar(source, defaultGetCodec, root)), /504/)
  source.close()
})

test('a gap-fill that returns the wrong bytes rejects on the multihash check', async () => {
  const { root, blocks } = await sharded()
  const omitted = blocks[blocks.length - 1]
  const source = new CarStreamSource('https://gw.example', {
    openCarStream: replay(blocks, (b) => (b.cid.equals(omitted.cid) ? null : b)),
    fetchRawBlock: async () => payload(99, 0xdead), // not the requested block
  })
  await assert.rejects(concat(exportCanonicalCar(source, defaultGetCodec, root)), /did not match multihash/)
  source.close()
})

test('a reversed (worst-case reordered) stream still completes — no deadlock', async () => {
  const { blockstore, root, blocks } = await sharded()
  const reference = await concat(exportCanonicalCar(blockstore, defaultGetCodec, root))
  // Deliver blocks in reverse: the exporter asks for the root (last to arrive)
  // first, so the pump must read the whole stream past the small buffer cap to
  // reach it. Liveness comes from never pausing while a get is outstanding.
  const source = new CarStreamSource('https://gw.example', {
    openCarStream: replay([...blocks].reverse()),
    maxBufferedBlocks: 2,
    fetchRawBlock: () => {
      throw new Error('reordering must not trigger gap-fill')
    },
  })
  const streamed = await concat(exportCanonicalCar(source, defaultGetCodec, root))
  source.close()
  assert.equal(sha(streamed), sha(reference))
})

test('one CAR request replaces one request per block (the throughput win)', async () => {
  const { root, blocks } = await sharded()
  assert.ok(blocks.length > 50, `expected a many-block DAG, got ${blocks.length}`)

  // The per-block path the CAR stream replaces: every get is its own request.
  let perBlockRequests = 0
  const perBlock = {
    get: async (cid: CID): Promise<Uint8Array> => {
      perBlockRequests++
      const found = blocks.find((b) => b.cid.equals(cid))
      if (found == null) throw new Error(`no block ${cid}`)
      return found.bytes
    },
  }
  await concat(exportCanonicalCar(perBlock, defaultGetCodec, root))

  let carRequests = 0
  let rawRequests = 0
  const source = new CarStreamSource('https://gw.example', {
    openCarStream: (r, s) => {
      carRequests++
      return replay(blocks)(r, s)
    },
    fetchRawBlock: async (cid) => {
      rawRequests++
      return blocks.find((b) => b.cid.equals(cid))?.bytes ?? new Uint8Array()
    },
  })
  await concat(exportCanonicalCar(source, defaultGetCodec, root))
  source.close()

  assert.equal(perBlockRequests, blocks.length, 'per-block path is one request per block')
  assert.equal(carRequests, 1, 'CAR-stream path is a single request for the whole DAG')
  assert.equal(rawRequests, 0, 'a complete stream needs no gap-fill')
})

test('a single small DAG round-trips through the source', async () => {
  const blockstore = new MemoryBlockstore()
  const { cid } = await importBytes(payload(2 * 1024 * 1024), blockstore)
  const root = CID.parse(cid.toString())
  const blocks = await canonicalBlocks(blockstore, root)
  const reference = await concat(exportCanonicalCar(blockstore, defaultGetCodec, root))
  const source = new CarStreamSource('https://gw.example', { openCarStream: replay(blocks) })
  const streamed = await concat(exportCanonicalCar(source, defaultGetCodec, root))
  source.close()
  assert.equal(sha(streamed), sha(reference))
})

test('aborting the lifecycle signal rejects an in-flight get', async () => {
  const { root, blocks } = await sharded()
  const controller = new AbortController()
  const source = new CarStreamSource('https://gw.example', {
    signal: controller.signal,
    // A stream that idles after the first block (observing abort, as a real
    // fetch body does) so the get for block 2 is parked until the abort.
    openCarStream: async function* (_root, signal) {
      yield blocks[0]
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('stream aborted')), { once: true })
      })
    },
    fetchRawBlock: async () => {
      throw new Error('should not gap-fill once aborted')
    },
  })
  await source.get(root) // block 0 served
  const pending = source.get(blocks[1].cid) // parks: never arrives, then aborts
  controller.abort()
  await assert.rejects(pending, /abort/i)
})
