import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { after, before, test } from 'node:test'
import * as JsHasher from '@web3-storage/data-segment/multihash'
import * as WasmHasher from 'fr32-sha2-256-trunc254-padded-binary-tree-multihash'
import type { CID } from 'multiformats/cid'
import * as Raw from 'multiformats/codecs/raw'
import * as Digest from 'multiformats/hashes/digest'
import * as Link from 'multiformats/link'
import { buildCarUrl, CAR_ACCEPT } from '../src/gateway.ts'
import { stopGatewayBlocks } from '../src/gateway-blocks.ts'
import { fetchAndComputePiece } from '../src/piece.ts'
import { fixtureCarPath, PINNED_CARS } from './pinned-cars.ts'

// The hermetic counterpart of the live gateway canary
// (commp-piece-cid-regression.test.ts). The CARs the canary fetches from
// trustless-gateway.link are committed under fixtures/cars, verified here
// against the same pinned sha256/size, and replayed from an in-process HTTP
// server through the same buildCarUrl request shape. This keeps the full
// fetch-and-hash path — fetchAndComputePiece included — in the merge-gating
// suite with no network, so a red live canary can only mean the real gateway
// changed its bytes, not a regression in this repo.
//
// Deliberately a plain HTTP replay, not a local IPFS node: a real node would
// re-serialize the CAR itself, making the local implementation's framing the
// thing under test instead of ours.

// fetchAndComputePiece builds a per-gateway helia node whose sockets keep the
// event loop alive; without this the file's process never exits.
after(async () => {
  await stopGatewayBlocks()
})

const fixtures = new Map<string, Buffer>()
let server: http.Server
let gateway: string

before(async () => {
  for (const known of PINNED_CARS) {
    fixtures.set(known.cid, await readFile(fixtureCarPath(known.cid)))
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address != null && typeof address === 'object')
  gateway = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
})

test('committed CAR fixtures match the canary pins byte for byte', () => {
  for (const known of PINNED_CARS) {
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

test('fetchAndComputePiece reproduces the pinned PieceCIDs over locally served CARs', async () => {
  for (const known of PINNED_CARS) {
    const piece = await fetchAndComputePiece(known.cid, [gateway])
    assert.equal(piece.pieceCid, known.pieceCid, `PieceCID drifted for ${known.cid}`)
    assert.equal(piece.rawSize, known.bytes)
    assert.equal(piece.memberSha256, known.sha256)
    assert.equal(piece.source, 'gateway')
    assert.equal(piece.url, buildCarUrl(gateway, known.cid))
  }
})

test('WASM hasher reproduces the pinned PieceCIDs over locally served CARs', async () => {
  for (const known of PINNED_CARS) {
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
  for (const known of PINNED_CARS) {
    const body = fixtures.get(known.cid)
    assert.ok(body != null)
    const hasher = JsHasher.create()
    hasher.write(body)
    const pieceCid = (Link.create(Raw.code, hasher.digest()) as CID).toString()
    assert.equal(pieceCid, known.pieceCid, `JS PieceCID drifted from pinned value for ${known.cid}`)
  }
})
