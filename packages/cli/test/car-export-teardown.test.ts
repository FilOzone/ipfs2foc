/**
 * `exportCanonicalCar` teardown: a consumer that stops early (without
 * aborting anything itself) must not leave the traversal running or parked —
 * the walk's block fetches must see an aborted signal, no further fetches
 * may start, and closing the consumer iterator must settle promptly. The
 * relay wraps the exporter specifically because of this hole; the fix
 * belongs in the exporter so every caller gets it.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryBlockstore } from 'blockstore-core'
import { importer } from 'ipfs-unixfs-importer'
import { exportCanonicalCar } from 'ipfs2foc-core/car-export'
import { defaultGetCodec } from 'ipfs2foc-core/car-stream-source'
import { CID } from 'multiformats/cid'

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function payload(n: number, seed: number): Uint8Array {
  const u8 = new Uint8Array(n)
  let x = seed >>> 0 || 1
  for (let i = 0; i < n; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    u8[i] = x & 0xff
  }
  return u8
}

/** A many-block DAG so the walk is still busy when the consumer leaves. */
async function bigDag(): Promise<{ blockstore: MemoryBlockstore; root: CID }> {
  const blockstore = new MemoryBlockstore()
  let last: { cid: unknown } | undefined
  for await (const entry of importer(
    Array.from({ length: 120 }, (_, i) => ({ path: `dir/f${i}.bin`, content: payload(256, i + 1) })),
    blockstore,
    { wrapWithDirectory: true, shardSplitThresholdBytes: 256 }
  )) {
    last = entry
  }
  if (last == null) throw new Error('importer yielded nothing')
  return { blockstore, root: CID.parse(String(last.cid)) }
}

test('early consumer exit aborts the walk and settles promptly', async () => {
  const { blockstore, root } = await bigDag()
  let gets = 0
  let lastSignal: AbortSignal | undefined
  const slowSource = {
    get: async (cid: CID, opts?: { signal?: AbortSignal }) => {
      gets++
      lastSignal = opts?.signal
      opts?.signal?.throwIfAborted()
      await wait(5)
      opts?.signal?.throwIfAborted()
      const chunks: Uint8Array[] = []
      for await (const c of blockstore.get(cid as never)) chunks.push(c)
      return chunks.length === 1 ? chunks[0] : new Uint8Array(Buffer.concat(chunks))
    },
  }

  const iter = exportCanonicalCar(slowSource, defaultGetCodec, root)[Symbol.asyncIterator]()
  const first = await iter.next()
  assert.equal(first.done, false)

  // Walk away mid-export. This must not hang, and it must stop the walk.
  let returned = false
  const closing = (async () => {
    await iter.return?.(undefined)
    returned = true
  })()
  await Promise.race([closing, wait(500)])
  assert.equal(returned, true, 'closing the export iterator must settle, not park')

  assert.ok(lastSignal, 'the walk must pass a signal to block fetches')
  assert.equal((lastSignal as AbortSignal).aborted, true, 'early exit must abort in-flight block fetches')

  const getsAtClose = gets
  await wait(50)
  assert.equal(gets, getsAtClose, 'no new block fetches may start after the consumer left')
})
