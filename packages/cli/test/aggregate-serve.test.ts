/**
 * End-to-end serve check for indexed aggregates: an HTTP GET of
 * `/piece/{root}` on the redirect handler must stream bytes whose recomputed
 * piece commitment equals the aggregate root — the exact verification the
 * provider's pull runs before parking the piece.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Piece } from '@web3-storage/data-segment'
import { buildIndexedAggregate } from 'ipfs2foc-core/indexed-aggregate'
import { MigrationDB } from '../src/db.ts'
import { makeRedirectHandler } from '../src/redirect-server.ts'

function payloadOf(byteLength: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(byteLength)
  for (let i = 0; i < byteLength; i++) {
    bytes[i] = (i * 13 + seed * 101 + ((i >> 7) & 0xff)) & 0xff
  }
  return bytes
}

test('GET /piece/{root} streams the assembled indexed aggregate byte-exactly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foc-aggserve-'))
  const db = new MigrationDB(join(dir, 'migrate.db'))
  const server = createServer(makeRedirectHandler(db))
  try {
    // Two assembled sub-pieces on disk (the payload bytes are what the piece
    // commitment was computed over; the streamer re-verifies them on the way
    // out).
    const subs = [payloadOf(150_000, 1), payloadOf(90_000, 2)].map((payload, i) => {
      const piece = Piece.fromPayload(payload)
      return { payload, pieceCid: piece.link.toString(), carPath: join(dir, `sub-${i}.car`) }
    })
    db.addCids(subs.map((s) => `src-${s.pieceCid}`))
    for (const s of subs) {
      await writeFile(s.carPath, s.payload)
      db.recordBuiltSubPiece({
        subPieceCid: s.pieceCid,
        assembledCarLength: s.payload.length,
        targetSizeBytes: 1 << 20,
        carPath: s.carPath,
        assembledSha256: 'unused',
        members: [{ cid: `src-${s.pieceCid}`, rawSize: s.payload.length, sha256: null }],
      })
    }
    const layout = buildIndexedAggregate(subs.map((s) => ({ pieceCid: s.pieceCid, rawSize: s.payload.length })))
    db.saveAggregate(
      0,
      layout.rootPieceCid,
      1n << 30n,
      subs.map((s) => s.pieceCid),
      true
    )

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    const res = await fetch(`http://127.0.0.1:${port}/piece/${layout.rootPieceCid}`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-length'), String(layout.streamLength))

    const body = new Uint8Array(await res.arrayBuffer())
    assert.equal(body.length, layout.streamLength)
    // The provider-side check: commP over the pulled bytes equals the root.
    assert.equal(Piece.fromPayload(body).link.toString(), layout.rootPieceCid)

    // HEAD answers the same length without a body.
    const head = await fetch(`http://127.0.0.1:${port}/piece/${layout.rootPieceCid}`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(layout.streamLength))
  } finally {
    server.close()
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
