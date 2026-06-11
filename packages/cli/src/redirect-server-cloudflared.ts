/**
 * Cloudflared "quick tunnel" ingress.
 *
 * Spawns `cloudflared tunnel --url http://localhost:<port>` against the local
 * redirect server. Cloudflare assigns a `*.trycloudflare.com` hostname with a
 * publicly-trusted TLS cert, runs an outbound connection to its edge, and
 * proxies inbound HTTPS to the local port. No account, no inbound port, works
 * behind CGNAT.
 *
 * The first stdout/stderr line carrying `https://<words>.trycloudflare.com` is
 * the public base URL — but the URL is printed BEFORE the tunnel registers
 * with the edge, and on networks that block outbound port 7844/UDP the
 * default QUIC transport never registers: every request to the hostname
 * returns Cloudflare error 1033 while cloudflared sits retrying. Registration
 * has its own log line (`Registered tunnel connection`, verified live against
 * cloudflared 2025.x in both protocols), so this module waits for it and, when
 * the default transport fails to register — or cloudflared's own precheck
 * names the blocked port — restarts the tunnel once with `--protocol http2`
 * (TCP), which registers on those networks. See docs/ingress.md.
 *
 * Cloudflare gates these quick tunnels behind their acceptable-use policy and
 * does not guarantee uptime. Fine for one-shot migrations; for production, use
 * a named tunnel (which needs an account) or another ingress.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { log } from './util.ts'

const URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
/** cloudflared logs this once a connection to the edge is established. */
const REGISTERED_REGEX = /Registered tunnel connection/
/** cloudflared's connectivity precheck names a blocked 7844 explicitly. */
const QUIC_BLOCKED_REGEX = /Allow outbound QUIC traffic on port 7844/

interface Options {
  /** Local TCP port the redirect server is already listening on. */
  port: number
  /** Milliseconds to wait for the tunnel URL before bailing. Default 60 s. */
  startupTimeoutMs?: number
  /**
   * Milliseconds to wait after the URL for edge registration before falling
   * back to http2. Registration follows the URL within seconds on a healthy
   * network (observed ~1-3s in both protocols). Default 20 s.
   */
  registrationTimeoutMs?: number
  /** Override the binary path; defaults to `cloudflared` on $PATH. */
  binary?: string
}

interface Attempt {
  baseUrl: string
  child: ChildProcess
  /** False when the URL was printed but the edge connection never registered. */
  registered: boolean
}

/** Spawn one cloudflared and wait for its URL, then for edge registration. */
function attemptTunnel(
  binary: string,
  port: number,
  opts: Required<Pick<Options, 'startupTimeoutMs' | 'registrationTimeoutMs'>>,
  protocol?: 'http2'
): Promise<Attempt> {
  const args = ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate']
  if (protocol != null) args.push('--protocol', protocol)
  // 127.0.0.1 explicitly: the serve daemon binds IPv4 loopback only, and a
  // dual-stack resolver would try ::1 first for `localhost`.
  log(`cloudflared ingress: spawning '${binary} ${args.join(' ')}'`)
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })

  // Fail-fast on missing binary.
  child.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log(
        `cloudflared ingress: '${binary}' not found on PATH. Install: 'brew install cloudflared' (macOS) or https://github.com/cloudflare/cloudflared/releases`
      )
    } else {
      log(`cloudflared ingress: spawn error: ${err.message}`)
    }
  })

  return new Promise<Attempt>((resolve, reject) => {
    let settled = false
    let baseUrl: string | null = null
    const buf: string[] = []
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const tail = (): string => buf.join('').split('\n').slice(-20).join('\n')

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      buf.push(text)
      const all = buf.join('')
      if (baseUrl == null) {
        const match = URL_REGEX.exec(text) ?? URL_REGEX.exec(all)
        if (match != null) {
          baseUrl = match[0]
          // The URL is necessary but not sufficient — registration decides.
          clearTimeout(urlTimer)
          regTimer = setTimeout(() => {
            settle(() => resolve({ baseUrl: baseUrl as string, child, registered: false }))
          }, opts.registrationTimeoutMs)
        }
      }
      if (baseUrl != null && REGISTERED_REGEX.test(all)) {
        settle(() => resolve({ baseUrl: baseUrl as string, child, registered: true }))
        return
      }
      // The precheck names the blocked port before the registration window
      // closes — no point waiting it out.
      if (baseUrl != null && QUIC_BLOCKED_REGEX.test(all) && protocol == null) {
        settle(() => resolve({ baseUrl: baseUrl as string, child, registered: false }))
      }
    }
    const onExit = (code: number | null): void => {
      settle(() =>
        reject(new Error(`cloudflared exited (code ${code ?? 'null'}) before printing a tunnel URL. Tail:\n${tail()}`))
      )
    }
    const urlTimer = setTimeout(() => {
      settle(() => {
        child.kill('SIGTERM')
        reject(
          new Error(
            `cloudflared did not print a tunnel URL within ${Math.round(opts.startupTimeoutMs / 1000)}s. Tail:\n${tail()}`
          )
        )
      })
    }, opts.startupTimeoutMs)
    let regTimer: NodeJS.Timeout | undefined
    const cleanup = (): void => {
      clearTimeout(urlTimer)
      clearTimeout(regTimer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
      child.off('exit', onExit)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', onExit)
  })
}

export async function startCloudflaredTunnel(opts: Options): Promise<{ baseUrl: string; child: ChildProcess }> {
  const binary = opts.binary ?? 'cloudflared'
  const timeouts = {
    startupTimeoutMs: opts.startupTimeoutMs ?? 60_000,
    registrationTimeoutMs: opts.registrationTimeoutMs ?? 20_000,
  }

  let attempt = await attemptTunnel(binary, opts.port, timeouts)
  if (!attempt.registered) {
    // QUIC (UDP 7844) is blocked on this network. One fallback, not a retry
    // loop: http2 rides TCP and registers where QUIC cannot (#48).
    log(
      'cloudflared ingress: tunnel printed a URL but never registered with the edge (outbound port 7844/UDP likely blocked). Retrying with --protocol http2.'
    )
    attempt.child.kill('SIGTERM')
    attempt = await attemptTunnel(binary, opts.port, timeouts, 'http2')
    if (!attempt.registered) {
      attempt.child.kill('SIGTERM')
      throw new Error(
        'cloudflared could not register with the edge on either transport (QUIC or http2). ' +
          'This network appears to block outbound port 7844 entirely — front the port yourself and use --public-base instead (docs/ingress.md).'
      )
    }
  }
  const { baseUrl, child } = attempt

  log(`cloudflared ingress: ready at ${baseUrl}`)
  log(`Pass it to pdp-submit: --source-base ${baseUrl}`)

  // Surface cloudflared exit so the operator sees the tunnel dropped.
  child.on('exit', (code, signal) => {
    log(`cloudflared ingress: tunnel exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
  })

  // Forward Ctrl-C cleanly so the child does not become an orphan.
  const shutdown = (): void => {
    if (!child.killed) child.kill('SIGTERM')
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  return { baseUrl, child }
}
