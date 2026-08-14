import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as JsHasher from '@web3-storage/data-segment/multihash'
import * as WasmHasher from 'fr32-sha2-256-trunc254-padded-binary-tree-multihash'
import type { CID } from 'multiformats/cid'
import * as Raw from 'multiformats/codecs/raw'
import * as Digest from 'multiformats/hashes/digest'
import * as Link from 'multiformats/link'
import { buildCarUrl, CAR_ACCEPT } from '../src/gateway.ts'

// The hermetic counterpart of the two live-gateway canaries
// (commp-piece-cid-regression.test.ts and the pinned-PieceCID test in
// commp-wasm-parity.test.ts). The CARs those canaries fetch from
// trustless-gateway.link are committed under fixtures/cars, verified here
// against the same pinned sha256/size, and replayed from an in-process HTTP
// server through the same buildCarUrl request shape. This keeps the full
// fetch-and-hash path in the merge-gating suite with no network, so a red
// live canary can only mean the real gateway changed its bytes — not a
// regression in this repo.
//
// Deliberately a plain HTTP replay, not a local IPFS node: a real node would
// re-serialize the CAR itself, making the local implementation's framing the
// thing under test instead of ours.

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cars')

interface PinnedCar {
  cid: string
  /** sha256 + size of the fixture CAR — same pins as the live canaries. */
  sha256: string
  bytes: number
  /** PieceCID v2 computed over that CAR. */
  pieceCid: string
}

const KNOWN: PinnedCar[] = [
  {
    cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    sha256: '89795ad1b0d2a9a712e67989122929c56bfa00ef3c1e063aca86d19a4025f589',
    bytes: 119874,
    pieceCid: 'bafkzcibdxzhqyefkufvnsmqlyrjyr3el6affnfo3l7ipfncjjzjl4hkaqhbaema3',
  },
  {
    cid: 'bafybeia2yt37rxkqu7ovw6ja3nf2aqatrzpcwh2tvl2kqbgeqcccn5evhy',
    sha256: '57aec52dbfc093616afb482a8eec4c877fba1bbf209e4b115764c131a88a0cbc',
    bytes: 5010728,
    pieceCid: 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa',
  },
]

const fixtures = new Map<string, Buffer>()
let server: http.Server
let gateway: string

before(async () => {
  for (const known of KNOWN) {
    fixtures.set(known.cid, await readFile(join(FIXTURE_DIR, `${known.cid}.car`)))
  }
  server = http.createServer((req, res) => {
    const match = /^\/ipfs\/([^?]+)/.exec(req.url ?? '')
    const body = match == null ? undefined : fixtures.get(match[1])
    if (body == null || req.headers.accept !== CAR_ACCEPT) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': CAR_ACCEPT }).end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address != null && typeof address === 'object')
  gateway = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
})

test('committed CAR fixtures match the canary pins byte for byte', () => {
  for (const known of KNOWN) {
    const body = fixtures.get(known.cid)
    assert.ok(body != null, `missing fixture for ${known.cid}`)
    assert.equal(body.byteLength, known.bytes, `fixture size drifted for ${known.cid}`)
    assert.equal(
      createHash('sha256').update(body).digest('hex'),
      known.sha256,
      `fixture sha256 drifted for ${known.cid}`
    )
  }
})

test('WASM hasher reproduces the pinned PieceCIDs over locally served CARs', async () => {
  for (const known of KNOWN) {
    const res = await fetch(buildCarUrl(gateway, known.cid), { headers: { accept: CAR_ACCEPT } })
    assert.equal(res.ok, true, `local fetch failed for ${known.cid}: HTTP ${res.status}`)
    assert.ok(res.body != null)
    const hasher = WasmHasher.create()
    let pieceCid: string
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hasher.write(chunk)
      }
      const out = new Uint8Array(hasher.multihashByteLength())
      hasher.digestInto(out, 0, true)
      pieceCid = (Link.create(Raw.code, Digest.decode(out)) as CID).toString()
    } finally {
      hasher.free()
    }
    assert.equal(pieceCid, known.pieceCid, `WASM PieceCID drifted from pinned value for ${known.cid}`)
  }
})

test('JS hasher reproduces the pinned PieceCIDs over the fixture CARs', () => {
  for (const known of KNOWN) {
    const body = fixtures.get(known.cid)
    assert.ok(body != null)
    const hasher = JsHasher.create()
    hasher.write(body)
    const pieceCid = (Link.create(Raw.code, hasher.digest()) as CID).toString()
    assert.equal(pieceCid, known.pieceCid, `JS PieceCID drifted from pinned value for ${known.cid}`)
  }
})
