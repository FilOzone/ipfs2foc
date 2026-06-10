/**
 * Stateless CAR relay for the in-browser BYOW migration dApp (#23, #45).
 *
 * A browser tab cannot accept the inbound `/piece/{pieceCidV2}` pull a storage
 * provider's PDP makes, so the dApp points the provider at this shared,
 * multi-tenant relay. The relay streams the canonical CAR for the routed CID:
 * one upstream `?format=car` request per pull, every block hash-verified, and
 * any block the gateway's CAR stream fails to deliver (truncation, corruption,
 * 504) recovered with a per-block `?format=raw` fetch. The output is the
 * canonical dfs/dups=n serialization — the very definition the piece
 * commitment was computed over — so the provider reads byte-identical bytes
 * whether or not the rebuild fired. This replaces the original 302 redirect,
 * whose one-shot gateway CAR fetch was unpullable for DAGs the gateway can
 * serve block-wise but not as one CAR.
 *
 * The routing is encoded entirely in the request path:
 *
 *     GET /r/{gatewayHost}/{cid}/piece/{pieceCidV2}
 *
 * Curio's pull validation (`pdp/pull_types.go#ValidatePullSourceURL`) only
 * requires the path to END with `/piece/{pieceCid}` (the regex is not
 * start-anchored) and the captured pieceCid to equal the on-chain value, over
 * HTTPS to a public host. So the dApp can prepend `/r/{gatewayHost}/{cid}` and
 * the relay recovers the routing from it — no registration, no KV, no TTL.
 *
 * Security: the relay never fetches a client-supplied URL. The `{gatewayHost}`
 * segment must be an EXACT member of the allowlist (not a URL to be parsed — a
 * bare hostname, matched literally), and upstream URLs are built from the
 * allowlist's own canonical string, so ports, userinfo (`@`), IDN homographs,
 * and percent-escapes cannot smuggle a different target. The `{cid}` must be a
 * canonical CIDv1 (round-trip identity) so the relay can only ever serve the
 * exact bytes the commitment was computed over.
 */

import { canonicalCid, defaultGatewayHosts } from 'ipfs2foc-core'
import { exportCanonicalCar } from 'ipfs2foc-core/car-export'
import { CarStreamSource, type CarStreamSourceOptions, defaultGetCodec } from 'ipfs2foc-core/car-stream-source'
import { CID } from 'multiformats/cid'

export interface RelayEnv {
  /**
   * Optional comma-separated extra gateway hostnames to allow, on top of the
   * built-in {@link defaultGatewayHosts}. Lets an operator widen the trust set
   * by config rather than code. Host only — no scheme, port, or path.
   */
  ALLOWED_GATEWAY_HOSTS?: string
}

/**
 * Test seam: the worker entry passes nothing, tests inject fake
 * `openCarStream`/`fetchRawBlock` so the rebuild logic runs without a network.
 */
export interface HandleOptions {
  carStreamSourceOptions?: Pick<CarStreamSourceOptions, 'openCarStream' | 'fetchRawBlock'>
}

/** Reject absurdly long paths before any parsing. A valid route is well under this. */
const MAX_PATH_LENGTH = 512

const CAR_CONTENT_TYPE = 'application/vnd.ipld.car'

const IDENTITY_MULTIHASH_CODE = 0x0

/**
 * Reorder-buffer cap for the relay. The default (128) could hold 128 MiB of
 * 1 MiB blocks per pull when the gateway outruns the provider's read — the
 * normal case — against a 128 MB isolate shared across requests. 16 keeps the
 * stream warm without risking memory.
 */
const RELAY_MAX_BUFFERED_BLOCKS = 16

/**
 * Exporter lookahead. Its purpose — overlapping per-block round-trip latency —
 * is mostly moot when blocks arrive on one CAR stream; gap-fill is the only
 * per-block path. Small keeps resident block bytes bounded alongside the
 * reorder buffer above.
 */
const RELAY_LOOKAHEAD = 8

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
  })
}

/** The allowlist for this request: built-in trusted hosts plus any configured. */
function allowedHosts(env: RelayEnv): Set<string> {
  const extra = (env.ALLOWED_GATEWAY_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0)
  return new Set([...defaultGatewayHosts().map((h) => h.toLowerCase()), ...extra])
}

/**
 * Resolve `GET /r/{gatewayHost}/{cid}/piece/{pcid}` to a streamed canonical CAR.
 *
 * Parsing is strict and decode-free: the segments are split literally, any
 * percent-encoding is rejected (valid hostnames and CIDv1s never need it, and
 * not decoding closes the decode-then-reinterpret class of host smuggling), and
 * the arity/shape must match exactly. `{pcid}` is intentionally not validated —
 * it exists only to satisfy Curio's suffix rule and is the provider's check, not
 * the relay's.
 */
async function handlePull(
  pathname: string,
  method: string,
  env: RelayEnv,
  requestSignal: AbortSignal,
  opts: HandleOptions
): Promise<Response> {
  const parts = pathname.split('/')
  // ['', 'r', gatewayHost, cid, 'piece', pcid]
  if (parts.length !== 6 || parts[1] !== 'r' || parts[4] !== 'piece') return text('not found', 404)
  const [, , gatewayHostRaw, cidRaw, , pcid] = parts
  if (gatewayHostRaw.length === 0 || cidRaw.length === 0 || pcid.length === 0 || pathname.includes('%')) {
    return text('not found', 404)
  }

  // Exact, case-folded allowlist membership. The input is a bare hostname, not a
  // URL — matching it literally (rather than parsing `https://<seg>` and reading
  // .hostname) rejects ports, userinfo, IDN, and percent tricks in one stroke.
  const host = gatewayHostRaw.toLowerCase()
  if (!allowedHosts(env).has(host)) return text('gateway host not on allowlist', 403)

  // Canonical CIDv1 only: the CAR must be built over the exact string the
  // browser hashed (the CID is the CAR root). Reject anything that does not
  // round-trip.
  const cid = canonicalCid(cidRaw)
  if (cid == null) return text('not a canonical CIDv1', 404)

  // HEAD: monitors and some clients probe the pull URL. Answer the shape of the
  // GET without opening an upstream stream.
  if (method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { 'content-type': CAR_CONTENT_TYPE, 'cache-control': 'no-store' },
    })
  }

  const root = CID.parse(cid)
  const source = new CarStreamSource(`https://${host}`, {
    ...opts.carStreamSourceOptions,
    maxBufferedBlocks: RELAY_MAX_BUFFERED_BLOCKS,
    signal: requestSignal,
  })

  // Prefetch the root so a totally-unfetchable DAG maps to a real error status
  // instead of a truncated 200 — once streaming starts the status is sent.
  // Identity roots carry their bytes in the CID; the exporter inlines them and
  // never calls `get`, so prefetching one would open a pointless gateway stream.
  let prefetchedRoot: Uint8Array | null = null
  if (root.multihash.code !== IDENTITY_MULTIHASH_CODE) {
    try {
      prefetchedRoot = await source.get(root, { signal: requestSignal })
    } catch (err) {
      source.close()
      console.error(`root ${cid} unfetchable from ${host}:`, err)
      return text('source unavailable at gateway', 502)
    }
  }

  // Hand the prefetched root to the exporter's first get. The DFS walk asks
  // for the root first and dedups by multihash, so it asks exactly once; the
  // multihash comparison keeps the stash inert for every other block.
  let rootServed = false
  const stash = {
    get: (blockCid: CID, options?: { signal?: AbortSignal }): Promise<Uint8Array> => {
      if (!rootServed && prefetchedRoot != null && sameBytes(blockCid.multihash.bytes, root.multihash.bytes)) {
        rootServed = true
        return Promise.resolve(prefetchedRoot)
      }
      return source.get(blockCid, options)
    },
  }

  // The wrapping generator's `finally` is the one hook that runs on consumer
  // cancel (ReadableStream.from turns cancel() into iterator.return()), on
  // error, and on success — exportCanonicalCar's own cleanup does not run on an
  // early return, so without this a provider disconnect would leak the upstream
  // gateway fetch.
  async function* stream(): AsyncGenerator<Uint8Array, void, undefined> {
    try {
      yield* exportCanonicalCar(stash, defaultGetCodec, root, {
        lookahead: RELAY_LOOKAHEAD,
        signal: requestSignal,
      })
    } catch (err) {
      // Erroring the stream mid-body surfaces to the provider as a transport
      // abort (no terminal chunk), never a clean-looking truncated CAR.
      console.error(`canonical CAR stream for ${cid} failed:`, err)
      throw err
    } finally {
      source.close()
      if (source.gapFillCount > 0) {
        console.warn(`rebuilt ${source.gapFillCount} block(s) via raw fetch for ${cid}`)
      }
    }
  }

  const from = (ReadableStream as unknown as { from(it: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> }).from
  return new Response(from(stream()), {
    status: 200,
    headers: { 'content-type': CAR_CONTENT_TYPE, 'cache-control': 'no-store' },
  })
}

/**
 * The relay's request handler. No environment state beyond the optional
 * allowlist config. Kept in this (non-entry) module so it can carry value
 * exports; the thin `worker.ts` entry wires it in as `fetch` (a Worker entry
 * module may only export handlers).
 */
export async function handle(request: Request, env: RelayEnv = {}, opts: HandleOptions = {}): Promise<Response> {
  const url = new URL(request.url)

  // Health check for monitors/ingress. GET or HEAD.
  if (url.pathname === '/healthz') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return text('method not allowed', 405)
    return text('ok', 200)
  }

  if (url.pathname.length > MAX_PATH_LENGTH) return text('not found', 404)

  if (url.pathname.startsWith('/r/')) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return text('method not allowed', 405)
    return handlePull(url.pathname, request.method, env, request.signal, opts)
  }

  return text('not found', 404)
}
