import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CarWriter } from '@ipld/car'
import * as dagPb from '@ipld/dag-pb'
import { relayPullUrl } from 'ipfs2foc-core'
import type { HandleOptions, RelayEnv } from '../handler.ts'
import { handle } from '../handler.ts'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'

// Known-good values: a canonical CIDv1 source and the PieceCID v2 computed over
// its CAR, matching test/commp-piece-cid-regression.test.ts. CID_V0 is a
// well-known example CIDv0.
const SOURCE_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const PIECE_CID = 'bafkzcibdxzhqyefkufvnsmqlyrjyr3el6affnfo3l7ipfncjjzjl4hkaqhbaema3'
const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
const HOST = 'trustless-gateway.link'
const CAR_CONTENT_TYPE = 'application/vnd.ipld.car'

function get(path: string, env: RelayEnv = {}, method = 'GET', opts: HandleOptions = {}): Promise<Response> {
  // Exercise the routing handler directly. The Worker entry's per-IP rate
  // limit (a Cloudflare binding) is verified live, not here.
  return handle(new Request(`https://relay.example${path}`, { method }), env, opts)
}

/** Build the stateless pull path the dApp would hand the provider. */
function pullPath(host: string, cid: string, pcid = PIECE_CID): string {
  return `/r/${host}/${cid}/piece/${pcid}`
}

interface Block {
  cid: CID
  bytes: Uint8Array
}

async function rawBlock(payload: string): Promise<Block> {
  const bytes = new TextEncoder().encode(payload)
  const digest = await sha256.digest(bytes)
  return { cid: CID.createV1(raw.code, digest), bytes }
}

/** A three-block DAG: dag-pb root linking two raw leaves, DFS order [root, a, b]. */
async function makeDag(): Promise<{ root: Block; blocks: Block[] }> {
  const a = await rawBlock('leaf a')
  const b = await rawBlock('leaf b')
  // `as never`: the repo pins multiformats ^13 while @ipld/dag-pb types against
  // ^14; the runtime objects interoperate (same cast as core's car-export.ts).
  const node = dagPb.encode({
    Links: [
      { Hash: a.cid as never, Name: 'a', Tsize: a.bytes.length },
      { Hash: b.cid as never, Name: 'b', Tsize: b.bytes.length },
    ],
  })
  const rootCid = CID.createV1(dagPb.code, await sha256.digest(node))
  return { root: { cid: rootCid, bytes: node }, blocks: [{ cid: rootCid, bytes: node }, a, b] }
}

/** The canonical CARv1 bytes (dfs, dups=n) for the DAG — what the commitment is over. */
async function canonicalCarBytes(root: CID, blocks: Block[]): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create([root] as never)
  const chunks: Uint8Array[] = []
  const collect = (async () => {
    for await (const chunk of out) chunks.push(chunk)
  })()
  for (const block of blocks) await writer.put(block as never)
  await writer.close()
  await collect
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const outBytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    outBytes.set(chunk, offset)
    offset += chunk.length
  }
  return outBytes
}

async function bodyBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer())
}

test('healthy gateway stream relays the byte-identical canonical CAR', async () => {
  const { root, blocks } = await makeDag()
  const expected = await canonicalCarBytes(root.cid, blocks)
  let rawFetches = 0
  const res = await get(pullPath(HOST, root.cid.toString()), {}, 'GET', {
    carStreamSourceOptions: {
      openCarStream: async function* () {
        yield* blocks
      },
      fetchRawBlock: async () => {
        rawFetches++
        throw new Error('must not be called for a healthy stream')
      },
    },
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), CAR_CONTENT_TYPE)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await bodyBytes(res), expected)
  assert.equal(rawFetches, 0)
})

test('truncated gateway stream is rebuilt block-by-block to identical bytes', async () => {
  const { root, blocks } = await makeDag()
  const expected = await canonicalCarBytes(root.cid, blocks)
  const byKey = new Map(blocks.map((b) => [b.cid.toString(), b.bytes]))
  const rawFetched: string[] = []
  const res = await get(pullPath(HOST, root.cid.toString()), {}, 'GET', {
    carStreamSourceOptions: {
      // The gateway delivers the root then dies mid-stream — the live failure
      // class (200 + partial body).
      openCarStream: async function* () {
        yield blocks[0]
        throw new Error('gateway request received 504 Gateway Timeout')
      },
      fetchRawBlock: async (cid) => {
        rawFetched.push(cid.toString())
        const bytes = byKey.get(cid.toString())
        if (bytes == null) throw new Error(`unexpected raw fetch ${cid}`)
        return bytes
      },
    },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await bodyBytes(res), expected)
  // Both leaves were recovered over ?format=raw.
  assert.deepEqual(rawFetched.sort(), [blocks[1].cid.toString(), blocks[2].cid.toString()].sort())
})

test('corrupt block in the stream is dropped and recovered via raw fetch', async () => {
  const { root, blocks } = await makeDag()
  const expected = await canonicalCarBytes(root.cid, blocks)
  const byKey = new Map(blocks.map((b) => [b.cid.toString(), b.bytes]))
  const res = await get(pullPath(HOST, root.cid.toString()), {}, 'GET', {
    carStreamSourceOptions: {
      openCarStream: async function* () {
        yield blocks[0]
        // Wrong bytes under leaf a's CID: hash-verification must reject it.
        yield { cid: blocks[1].cid, bytes: new TextEncoder().encode('evil') }
        yield blocks[2]
      },
      fetchRawBlock: async (cid) => {
        const bytes = byKey.get(cid.toString())
        if (bytes == null) throw new Error(`unexpected raw fetch ${cid}`)
        return bytes
      },
    },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await bodyBytes(res), expected)
})

test('unfetchable root returns 502, not a truncated 200', async () => {
  const { root } = await makeDag()
  const res = await get(pullPath(HOST, root.cid.toString()), {}, 'GET', {
    carStreamSourceOptions: {
      openCarStream: async function* () {
        throw new Error('gateway request received 404 Not Found')
      },
      fetchRawBlock: async () => {
        throw new Error('gateway request received 404 Not Found')
      },
    },
  })
  assert.equal(res.status, 502)
})

test('HEAD on the pull path answers 200 with the CAR content type and no upstream fetch', async () => {
  let touched = false
  const res = await get(pullPath(HOST, SOURCE_CID), {}, 'HEAD', {
    carStreamSourceOptions: {
      openCarStream: async function* () {
        touched = true
        yield* []
      },
      fetchRawBlock: async () => {
        touched = true
        throw new Error('unreachable')
      },
    },
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), CAR_CONTENT_TYPE)
  assert.equal(res.body, null)
  assert.equal(touched, false)
})

test('userinfo (@) smuggling is rejected — not an exact allowlist member', async () => {
  // `evil.com@trustless-gateway.link`: the stateful relay used to ACCEPT this
  // (URL.hostname resolves to the trusted host). Exact-membership matching
  // rejects it, and crucially the relay never fetches the raw segment.
  assert.equal((await get(pullPath('evil.com@trustless-gateway.link', SOURCE_CID))).status, 403)
})

test('port-bearing host is rejected', async () => {
  assert.equal((await get(pullPath('trustless-gateway.link:8443', SOURCE_CID))).status, 403)
})

test('look-alike subdomain and arbitrary host are rejected', async () => {
  assert.equal((await get(pullPath('trustless-gateway.link.evil.com', SOURCE_CID))).status, 403)
  assert.equal((await get(pullPath('evil.example.com', SOURCE_CID))).status, 403)
})

test('percent-encoding anywhere in the path is rejected (no decode-then-reinterpret)', async () => {
  // `trustless-gateway%2elink` would decode to the trusted host; reject outright.
  assert.equal((await get(pullPath('trustless-gateway%2elink', SOURCE_CID))).status, 404)
  assert.equal((await get(pullPath(HOST, `${SOURCE_CID}%2f..`))).status, 404)
})

test('non-canonical CIDs are rejected (CIDv0, junk)', async () => {
  // CIDv0 (base58, version 0) — different bytes than the committed CIDv1 form.
  assert.equal((await get(pullPath(HOST, CID_V0))).status, 404)
  // Uppercased base32 v1 does not round-trip to itself.
  assert.equal((await get(pullPath(HOST, SOURCE_CID.toUpperCase()))).status, 404)
  assert.equal((await get(pullPath(HOST, 'not-a-cid'))).status, 404)
})

test('extra allowlisted host via env is accepted', async () => {
  const env: RelayEnv = { ALLOWED_GATEWAY_HOSTS: 'ipfs.example.org' }
  const { root, blocks } = await makeDag()
  const expected = await canonicalCarBytes(root.cid, blocks)
  const res = await get(pullPath('ipfs.example.org', root.cid.toString()), env, 'GET', {
    carStreamSourceOptions: {
      openCarStream: async function* () {
        yield* blocks
      },
    },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await bodyBytes(res), expected)
})

test('strict path shape: wrong arity, trailing slash, missing /piece', async () => {
  assert.equal((await get(`/r/${HOST}/${SOURCE_CID}/piece/${PIECE_CID}/`)).status, 404) // trailing slash
  assert.equal((await get(`/r/${HOST}/${SOURCE_CID}/${PIECE_CID}`)).status, 404) // no /piece segment
  assert.equal((await get(`/r/${HOST}/piece/${PIECE_CID}`)).status, 404) // missing cid
  assert.equal((await get(`/r/${HOST}/${SOURCE_CID}/piece/${PIECE_CID}/extra`)).status, 404) // extra segment
})

test('overlong path is rejected before parsing', async () => {
  assert.equal((await get(`/r/${HOST}/${'a'.repeat(600)}/piece/${PIECE_CID}`)).status, 404)
})

test('submit-built relay URL parses back to the exact committed canonical CAR (build↔parse loop)', async () => {
  // What the submit side emits (relayPullUrl) must, when the relay parses it,
  // stream the identical canonical CAR the piece was committed over. This
  // closes the loop between src/submit-pdp.ts and relay/handler.ts.
  const { root, blocks } = await makeDag()
  const expected = await canonicalCarBytes(root.cid, blocks)
  const built = relayPullUrl('https://relay.example', HOST, root.cid.toString(), PIECE_CID)
  const path = new URL(built).pathname
  const res = await handle(new Request(`https://relay.example${path}`), {}, {
    carStreamSourceOptions: {
      openCarStream: async function* () {
        yield* blocks
      },
    },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await bodyBytes(res), expected)
})

test('consumer cancel mid-stream tears down the upstream source', async () => {
  const { root, blocks } = await makeDag()
  let streamSignal: AbortSignal | undefined
  let firstBlockOut: (() => void) | undefined
  const firstBlock = new Promise<void>((resolve) => {
    firstBlockOut = resolve
  })
  const res = await get(pullPath(HOST, root.cid.toString()), {}, 'GET', {
    carStreamSourceOptions: {
      openCarStream: async function* (_root, signal) {
        streamSignal = signal
        yield blocks[0]
        firstBlockOut?.()
        // Park until torn down; a leak would keep this hanging forever.
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    },
  })
  assert.equal(res.status, 200)
  assert.ok(res.body != null)
  const reader = res.body.getReader()
  await reader.read() // CAR header (and possibly more) — the stream is live
  await firstBlock
  await reader.cancel()
  // cancel() → iterator.return() → the handler's finally → source.close(),
  // which aborts the pump's signal.
  assert.equal(streamSignal?.aborted, true)
})

test('method and routing guards', async () => {
  assert.equal((await get(pullPath(HOST, SOURCE_CID), {}, 'POST')).status, 405)
  assert.equal((await get('/healthz')).status, 200)
  assert.equal((await get('/healthz', {}, 'HEAD')).status, 200)
  assert.equal((await get('/healthz', {}, 'POST')).status, 405)
  assert.equal((await get('/')).status, 404)
  assert.equal((await get('/nope')).status, 404)
})
