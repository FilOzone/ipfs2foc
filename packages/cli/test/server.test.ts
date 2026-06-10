import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MigrationDB } from '../src/db.ts'
import { Runner } from '../src/runner.ts'
import { type IngressState, startServer } from '../src/server.ts'

// The serve daemon is the local backend behind the browser console: it must
// report its capabilities, serve the bundled console (SPA fallback, cache
// headers, no traversal), and keep the control-plane API loopback-only —
// foreign Hosts and Origins are rejected, plain curl is not.

async function harness(opts: { appDir?: 'fixture' | 'missing'; ingress?: IngressState } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'foc-serve-'))
  let appDir = join(dir, 'app')
  if (opts.appDir === 'missing') {
    appDir = join(dir, 'nope')
  } else {
    await mkdir(join(appDir, 'assets'), { recursive: true })
    await writeFile(join(appDir, 'index.html'), '<!doctype html><title>console fixture</title>')
    await writeFile(join(appDir, 'assets', 'main-abc123.js'), 'console.log("fixture")')
  }
  const db = new MigrationDB(join(dir, 'migrate.db'))
  const runner = new Runner(db, { gateways: ['https://gw.example'], concurrency: 1, aggregateSizeBytes: 1024n })
  const ingress: IngressState = opts.ingress ?? { publicBase: null, reachable: null }
  const server: Server = await startServer({ db, runner, port: 0, network: 'mainnet', appDir, ingress })
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
  return { base, close, db, ingress }
}

/** A passthrough sub-piece a provider could pull: 302 to the gateway CAR. */
function seedPassthroughPiece(db: MigrationDB): void {
  db.addCids(['bafSrc'])
  db.recordPieceSuccess('bafSrc', 'pcPass', 100, 'g', 'https://gw.example/ipfs/bafSrc?format=car', 'sha')
  db.recordPassthroughSubPiece({
    subPieceCid: 'pcPass',
    sourceCid: 'bafSrc',
    url: 'https://gw.example/ipfs/bafSrc?format=car',
    rawSize: 100,
    memberSha256: null,
  })
}

test('capabilities reports the local backend contract', async () => {
  const h = await harness()
  try {
    const res = await fetch(`${h.base}/api/capabilities`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
    const caps = await res.json()
    assert.deepEqual(caps, {
      schemaVersion: 1,
      backend: 'local',
      network: 'mainnet',
      apiBase: '/api',
      pieceBase: null,
      supportsAssembledPieces: true,
      supportsServerCommp: true,
      supportsBrowserSigning: false,
      requiresPublicIngress: true,
    })
  } finally {
    await h.close()
  }
})

test('capabilities and status reflect ingress state live', async () => {
  const h = await harness()
  try {
    // The tunnel comes up after the server is already listening; mutating the
    // shared ingress object must be visible on the next request.
    h.ingress.publicBase = 'https://x.trycloudflare.com'
    h.ingress.reachable = true
    const caps = await (await fetch(`${h.base}/api/capabilities`)).json()
    assert.equal(caps.pieceBase, 'https://x.trycloudflare.com')
    const status = await (await fetch(`${h.base}/api/status`)).json()
    assert.deepEqual(status.ingress, { publicBase: 'https://x.trycloudflare.com', reachable: true })
  } finally {
    await h.close()
  }
})

test('healthz answers GET and HEAD', async () => {
  const h = await harness()
  try {
    const get = await fetch(`${h.base}/healthz`)
    assert.equal(get.status, 200)
    assert.equal(await get.text(), 'ok')
    const head = await fetch(`${h.base}/healthz`, { method: 'HEAD' })
    assert.equal(head.status, 200)
  } finally {
    await h.close()
  }
})

test('piece pulls 302 to the gateway CAR, GET and HEAD', async () => {
  const h = await harness()
  try {
    seedPassthroughPiece(h.db)
    for (const method of ['GET', 'HEAD']) {
      const res = await fetch(`${h.base}/piece/pcPass`, { method, redirect: 'manual' })
      assert.equal(res.status, 302)
      assert.equal(res.headers.get('location'), 'https://gw.example/ipfs/bafSrc?format=car')
      assert.equal(res.headers.get('cache-control'), 'no-store')
    }
  } finally {
    await h.close()
  }
})

test('unknown piece is 404, not the SPA fallback', async () => {
  const h = await harness()
  try {
    // PieceCIDs have no file extension; without the explicit /piece mount the
    // static handler would answer with index.html and a provider pull would
    // download HTML as the "CAR".
    const res = await fetch(`${h.base}/piece/pcNope`)
    assert.equal(res.status, 404)
    assert.doesNotMatch(await res.text(), /console fixture/)
  } finally {
    await h.close()
  }
})

test('piece route works with a public Host header (tunnel case)', async () => {
  const h = await harness()
  try {
    seedPassthroughPiece(h.db)
    // Tunnel requests carry the public hostname; /piece must not be
    // Host-gated the way /api is. fetch() refuses custom Host — raw request.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${h.base}/piece/pcPass`, { headers: { host: 'pub.trycloudflare.com' } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 302)
  } finally {
    await h.close()
  }
})

test('serves index.html at / with no-store', async () => {
  const h = await harness()
  try {
    const res = await fetch(`${h.base}/`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.match(await res.text(), /console fixture/)
  } finally {
    await h.close()
  }
})

test('serves hashed assets with long-lived cache and correct MIME', async () => {
  const h = await harness()
  try {
    const res = await fetch(`${h.base}/assets/main-abc123.js`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/javascript/)
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  } finally {
    await h.close()
  }
})

test('extension-less paths fall back to index.html; missing assets 404', async () => {
  const h = await harness()
  try {
    const fallback = await fetch(`${h.base}/some/app/route`)
    assert.equal(fallback.status, 200)
    assert.match(await fallback.text(), /console fixture/)
    const missing = await fetch(`${h.base}/assets/nope.js`)
    assert.equal(missing.status, 404)
  } finally {
    await h.close()
  }
})

test('path traversal outside the app dir is rejected', async () => {
  const h = await harness()
  try {
    const res = await fetch(`${h.base}/..%2F..%2Fetc%2Fpasswd`)
    assert.equal(res.status, 404)
  } finally {
    await h.close()
  }
})

test('unknown /api routes stay JSON 404', async () => {
  const h = await harness()
  try {
    const res = await fetch(`${h.base}/api/nope`)
    assert.equal(res.status, 404)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  } finally {
    await h.close()
  }
})

test('cross-origin POST is rejected; no-Origin POST works', async () => {
  const h = await harness()
  try {
    const evil = await fetch(`${h.base}/api/pause`, { method: 'POST', headers: { origin: 'http://evil.example' } })
    assert.equal(evil.status, 403)
    const local = await fetch(`${h.base}/api/pause`, { method: 'POST', headers: { origin: h.base } })
    assert.equal(local.status, 200)
    const curl = await fetch(`${h.base}/api/pause`, { method: 'POST' })
    assert.equal(curl.status, 200)
  } finally {
    await h.close()
  }
})

test('non-local Host header is rejected on /api (DNS rebinding)', async () => {
  const h = await harness()
  try {
    // fetch() refuses to send a custom Host header — use a raw request.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${h.base}/api/status`, { headers: { host: 'evil.example:4321' } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 403)
    const ok = await fetch(`${h.base}/api/status`)
    assert.equal(ok.status, 200)
  } finally {
    await h.close()
  }
})

test('missing app dir yields 503 with build instructions, API still works', async () => {
  const h = await harness({ appDir: 'missing' })
  try {
    const res = await fetch(`${h.base}/`)
    assert.equal(res.status, 503)
    assert.match(await res.text(), /--app-dir/)
    const api = await fetch(`${h.base}/api/status`)
    assert.equal(api.status, 200)
  } finally {
    await h.close()
  }
})
