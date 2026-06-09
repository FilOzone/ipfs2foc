/**
 * Daemon + migration console. A tiny node:http server that owns a Runner and
 * the DB, so a migration can run in the background while the operator watches
 * progress and controls it from a browser: start/pause/resume, add CIDs (paste
 * or upload a .txt), add gateways, retry failures.
 *
 * No web framework — just node:http serving the built browser console (the
 * same app the hosted site runs, adapting via GET /api/capabilities) plus
 * JSON APIs that stay curl-friendly for scripting.
 *
 * The server binds loopback only and checks the Host header on /api routes
 * (a DNS-rebound hostname must not read run state) and the Origin header on
 * mutating routes (a foreign page must not drive the runner). Requests
 * without an Origin — curl, scripts — pass.
 */

import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAPABILITIES_SCHEMA_VERSION, type Capabilities } from 'ipfs2foc-core/capabilities'
import type { MigrationDB } from './db.ts'
import { type BaseFeeReading, classifyBaseFee, getBaseFee } from './gas.ts'
import type { Runner } from './runner.ts'
import { log, parseCidList } from './util.ts'

export interface GasConfig {
  rpcUrl: string
  maxBaseFee: bigint
}

export interface ServeOptions {
  db: MigrationDB
  runner: Runner
  port: number
  /** Network reported via /api/capabilities (the runner itself is chain-free). */
  network: 'mainnet' | 'calibration'
  /** Directory holding the built browser console; defaults to the bundled copy. */
  appDir?: string
  gas?: GasConfig
}

/**
 * Where the built browser console lives when none is given explicitly.
 *
 * PROVISIONAL PACKAGING (revisit before the app grows): the built app ships
 * inside the ipfs2foc tarball as `app-dist/` (see the package.json `files`
 * entry and the `build` script that produces it), trading ~8× package size
 * for a single atomic version. Candidates for later: a separate app assets
 * package, or an optionalDependency headless installs can omit. The
 * /api/capabilities schemaVersion keeps either move drift-safe.
 *
 * The relative hop works from both `dist/` (bundled) and `src/` (running the
 * sources directly) because both sit one level below the package root — keep
 * that invariant if the build output ever moves.
 */
function defaultAppDir(): string {
  return fileURLToPath(new URL('../app-dist/', import.meta.url))
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function isLocalHost(hostHeader: string | undefined): boolean {
  if (hostHeader == null) return false
  // Host is `name[:port]`; a bracketed IPv6 literal keeps its brackets.
  const name = hostHeader.startsWith('[') ? hostHeader.replace(/\]:\d+$/, ']') : hostHeader.replace(/:\d+$/, '')
  return LOCAL_HOSTS.has(name.toLowerCase())
}

function isLocalOrigin(origin: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase())
  } catch {
    return false
  }
}

export async function startServer(opts: ServeOptions): Promise<Server> {
  const { db, runner, port, network, gas } = opts
  const appDir = resolve(opts.appDir ?? defaultAppDir())

  // Poll the network base fee in the background so the console can show it and
  // flag when submission should pause. Read-only; never blocks the commP loop.
  let baseFee: BaseFeeReading | null = null
  if (gas != null) {
    const poll = async (): Promise<void> => {
      try {
        baseFee = classifyBaseFee(await getBaseFee(gas.rpcUrl), gas.maxBaseFee)
      } catch (err) {
        log(`baseFee poll failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    void poll()
    setInterval(() => void poll(), 20_000).unref()
  }
  const gasStatus = (): unknown =>
    baseFee == null
      ? null
      : {
          baseFee: baseFee.baseFee.toString(),
          multipleOfFloor: baseFee.multipleOfFloor,
          level: baseFee.level,
          pause: baseFee.pause,
          maxBaseFee: gas?.maxBaseFee.toString() ?? null,
        }

  const capabilities: Capabilities = {
    schemaVersion: CAPABILITIES_SCHEMA_VERSION,
    backend: 'local',
    network,
    apiBase: '/api',
    // Piece serving, assembled CARs, and browser signing arrive with the
    // inbound /piece endpoint and the local BYOW flow; until then the console
    // is a control plane over the commP/packing stage.
    pieceBase: null,
    supportsAssembledPieces: false,
    supportsServerCommp: true,
    supportsBrowserSigning: false,
    requiresPublicIngress: false,
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = `${req.method} ${url.pathname}`

    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    const readBody = async (): Promise<string> => {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(chunk as Buffer)
      }
      return Buffer.concat(chunks).toString('utf8')
    }

    void (async () => {
      try {
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
          if (!isLocalHost(req.headers.host)) {
            json(403, { error: 'forbidden: API is loopback-only' })
            return
          }
          if (req.method === 'POST' && req.headers.origin != null && !isLocalOrigin(req.headers.origin)) {
            json(403, { error: `forbidden: cross-origin request from ${req.headers.origin}` })
            return
          }
        }

        switch (route) {
          case 'GET /api/capabilities':
            json(200, capabilities)
            return

          case 'GET /api/status':
            json(200, { ...(status(db, runner) as object), gas: gasStatus() })
            return

          case 'POST /api/start':
            runner.start()
            json(200, { state: runner.state })
            return

          case 'POST /api/pause':
            runner.pause()
            json(200, { state: runner.state })
            return

          case 'POST /api/resume':
            runner.resume()
            json(200, { state: runner.state })
            return

          case 'POST /api/retry':
            runner.retryFailed()
            json(200, { state: runner.state })
            return

          case 'POST /api/cids': {
            const cids = parseCidList(await readBody())
            const added = runner.addCids(cids)
            json(200, { added, cids: cids.length })
            return
          }

          case 'POST /api/gateways': {
            const body = await readBody()
            let gateways: string[]
            try {
              const parsed = JSON.parse(body)
              gateways = Array.isArray(parsed) ? parsed : parsed.gateways
            } catch {
              gateways = body.split(/[\s,]+/).filter(Boolean)
            }
            runner.setGateways(gateways)
            json(200, { gateways: runner.gateways })
            return
          }

          default:
            if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
              json(404, { error: `no route ${route}` })
              return
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              json(404, { error: `no route ${route}` })
              return
            }
            await serveApp(appDir, url.pathname, req, res)
        }
      } catch (err) {
        json(500, { error: err instanceof Error ? err.message : String(err) })
      }
    })()
  })

  await new Promise<void>((resolveListen) => {
    // Loopback only: the console controls the runner and the API has no auth.
    server.listen(port, '127.0.0.1', resolveListen)
  })
  const actualPort = (server.address() as { port: number }).port
  log(`ipfs2foc console on http://localhost:${actualPort}`)
  return server
}

/** Serve the built browser console: static assets with an index.html fallback. */
async function serveApp(appDir: string, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!existsSync(join(appDir, 'index.html'))) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(
      `browser console not found at ${appDir}\n\n` +
        'Build it first (pnpm -C packages/cli build) or point at a built copy\n' +
        'with --app-dir / IPFS2FOC_APP_DIR. Note: a build for the hosted site\n' +
        'uses a different base path and will not work here.\n'
    )
    return
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('bad path')
    return
  }
  const candidate = resolve(join(appDir, decoded))
  if (candidate !== appDir && !candidate.startsWith(appDir + sep)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }

  let filePath = decoded === '/' ? join(appDir, 'index.html') : candidate
  let fileStat = await stat(filePath).catch(() => null)
  if (fileStat == null || !fileStat.isFile()) {
    // SPA fallback: extension-less paths are app routes; missing assets 404.
    if (extname(decoded) !== '') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    filePath = join(appDir, 'index.html')
    fileStat = await stat(filePath)
  }

  const isIndex = filePath === join(appDir, 'index.html')
  const headers: Record<string, string> = {
    'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'content-length': String(fileStat.size),
    // index.html references content-hashed assets; it must never go stale.
    // The hashed assets themselves are safe to cache forever.
    'cache-control': isIndex
      ? 'no-store'
      : decoded.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-store',
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(filePath)
    stream.pipe(res)
    stream.on('error', reject)
    res.on('finish', resolveStream)
    res.on('close', resolveStream)
  })
}

function status(db: MigrationDB, runner: Runner): unknown {
  return {
    state: runner.state,
    active: runner.active,
    gateways: runner.gateways,
    aggregateSizeBytes: runner.aggregateSizeBytes.toString(),
    dbPath: db.path,
    lastError: runner.lastError,
    counts: db.counts(),
    aggregates: db.aggregates(),
    failures: db.failures().slice(0, 50),
  }
}
