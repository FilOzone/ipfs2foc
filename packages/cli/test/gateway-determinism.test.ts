import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { after, test } from 'node:test'
import { CAR_ACCEPT, probeGateway } from '../src/gateway.ts'
import { stopGatewayBlocks } from '../src/gateway-blocks.ts'
import { fetchAndComputePiece } from '../src/piece.ts'
import { fixtureCarPath, PINNED_CARS } from './pinned-cars.ts'

// The detection responsibility, tested from the unhappy side. The migration
// contract depends on the source gateway serving byte-identical CARs across
// fetches; `probe` (via probeGateway's double-fetch compare) is what users run
// to verify that before trusting a gateway, and `analyze` samples it across
// their inventory. These tests stand up misbehaving local gateways — unstable
// framing, truncation — and assert the detectors actually fire. The stability
// of any real public gateway is that operator's business, not this suite's:
// nothing here (or anywhere in the suite) touches the network.

// fetchAndComputePiece builds a per-gateway helia node whose sockets keep the
// event loop alive; without this the file's process never exits.
after(async () => {
  await stopGatewayBlocks()
})

type Responder = (requestIndex: number) => { status?: number; body: Buffer }

async function withServer(respond: Responder, run: (gateway: string) => Promise<void>) {
  let requests = 0
  const server = http.createServer((req, res) => {
    if (req.headers.accept !== CAR_ACCEPT) {
      res.writeHead(404).end()
      return
    }
    const { status = 200, body } = respond(requests++)
    res.writeHead(status, { 'content-type': CAR_ACCEPT }).end(body)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address != null && typeof address === 'object')
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}

const pinned = PINNED_CARS[0]

test('probeGateway reports a byte-stable gateway as deterministic', async () => {
  const car = await readFile(fixtureCarPath(pinned.cid))
  await withServer(
    () => ({ body: car }),
    async (gateway) => {
      const result = await probeGateway(gateway, pinned.cid)
      assert.equal(result.servesCar, true)
      assert.equal(result.deterministic, true)
      assert.equal(result.sha256, pinned.sha256)
    }
  )
})

test('probeGateway catches a gateway whose CAR bytes differ between fetches', async () => {
  const car = await readFile(fixtureCarPath(pinned.cid))
  // Same length, same blocks conceptually — one flipped byte mid-payload is
  // the smallest possible framing drift, and it must not slip through.
  const drifted = Buffer.from(car)
  drifted[Math.floor(drifted.length / 2)] ^= 0xff
  await withServer(
    (i) => ({ body: i % 2 === 0 ? car : drifted }),
    async (gateway) => {
      const result = await probeGateway(gateway, pinned.cid)
      assert.equal(result.servesCar, true)
      assert.equal(result.deterministic, false, 'probe failed to flag an unstable gateway')
      assert.match(result.note ?? '', /two fetches differed/)
    }
  )
})

test('fetchAndComputePiece rejects a truncated CAR instead of hashing it silently', async () => {
  const car = await readFile(fixtureCarPath(pinned.cid))
  const truncated = car.subarray(0, Math.floor(car.length / 2))
  await withServer(
    () => ({ body: Buffer.from(truncated) }),
    async (gateway) => {
      // No expected-error filter: any rejection is the contract here — a
      // truncated CAR must fail the piece computation, never produce a wrong
      // PieceCID.
      await assert.rejects(fetchAndComputePiece(pinned.cid, [gateway]))
    }
  )
})
