/**
 * Helia-backed fallback for the trustless-gateway fetch path.
 *
 * The migrator's normal source is a single configured trustless gateway. When
 * that gateway returns 5xx/429 or fails the determinism check, an embedded
 * Helia node walks the DAG over bitswap and trustless-gateway block brokers
 * and re-assembles a CAR locally. The reassembled CAR's bytes are then hashed
 * and fed into the same piece commitment path as the gateway response.
 *
 * Lifecycle: the Helia node is created lazily on the first fallback hit. The
 * idle cost on happy-path runs is therefore zero. Call `stopHeliaFallback()`
 * during shutdown to close the node cleanly.
 *
 * Bitswap walk latency at million-CID scale is a known concern; this module
 * is opt-in via `--ipfs-fallback` so the operator chooses when to absorb it.
 *
 * Reachability note: the migrator only dials out. No inbound NAT traversal
 * (UPnP / AutoTLS) is required for outbound bitswap. Helia's default libp2p
 * config includes those services anyway; they are harmless when unused.
 */

import { CID } from 'multiformats/cid'

// Helia and @helia/car are imported dynamically inside the functions below so
// the module load itself stays cheap (no transitive native modules pulled in
// at startup). Required for the case where the operator never opts into
// `--ipfs-fallback` and we should not pay a Helia startup cost.
type HeliaInstance = Awaited<ReturnType<typeof loadHelia>> extends () => Promise<infer H> ? H : any
async function loadHelia() {
  const { createHelia } = await import('helia')
  return createHelia
}

/**
 * Helia's default libp2p config registers WebRTC and WebRTC-Direct transports,
 * which drag in @libp2p/webrtc → node-datachannel. node-datachannel only ships
 * NAPI v8 prebuilts; under Node 26 (NAPI v10) `prebuild-install` refuses the
 * download and the native binding is unavailable. Outbound bitswap does not
 * need WebRTC at all, so we filter both the transports and the matching
 * listen addresses. The result is a config that runs with the prebuilt
 * binaries we already have on disk.
 */
export async function buildLibp2pConfig(): Promise<Record<string, any>> {
  // Dynamic import so calling code that never engages the fallback does not
  // pay helia's module-graph cost (including the WebRTC transports we filter
  // out below).
  const { libp2pDefaults } = await import('helia')
  const cfg = libp2pDefaults() as Record<string, any>
  const webrtcRe = /WebRTC/i
  cfg.transports = (cfg.transports ?? []).filter((t: unknown) => {
    const repr = (t as { name?: string; toString?: () => string }).toString?.() ?? ''
    const name = (t as { name?: string }).name ?? ''
    return !(webrtcRe.test(repr) || webrtcRe.test(name))
  })
  cfg.addresses = {
    ...cfg.addresses,
    listen: (cfg.addresses?.listen ?? []).filter((a: string) => !/webrtc/i.test(a)),
  }
  return cfg
}

/** Default upper bound on a fallback fetch. The CLI exposes this as `--ipfs-fallback-timeout-seconds`. */
export const DEFAULT_FALLBACK_TIMEOUT_MS = 120_000

let heliaPromise: Promise<HeliaInstance> | null = null

/**
 * Lazily construct a Helia node. The first caller pays the startup cost;
 * subsequent callers share the same node for the lifetime of the process.
 */
export async function getHelia(): Promise<HeliaInstance> {
  if (heliaPromise == null) {
    const createHelia = await loadHelia()
    const libp2p = await buildLibp2pConfig()
    heliaPromise = (createHelia as (opts: { libp2p: unknown }) => Promise<HeliaInstance>)({ libp2p })
  }
  return heliaPromise as Promise<HeliaInstance>
}

/**
 * Tear down the Helia node if one was started. Safe to call when no node was
 * ever created (e.g. fallback never fired during the run).
 */
export async function stopHeliaFallback(): Promise<void> {
  if (heliaPromise == null) return
  const helia = await heliaPromise
  heliaPromise = null
  await helia.stop()
}

/**
 * Fetch a CID's full DAG over Helia and emit a CAR stream rooted at that CID.
 *
 * Returns a `ReadableStream<Uint8Array>` so the caller can pipe it through the
 * same piece-commitment hasher used for gateway responses. The dag-scope is
 * implicitly `all` — `@helia/car`'s `export` walks the full reachable DAG
 * from the given root.
 */
export async function fetchCarViaHelia(
  cid: string,
  opts: { timeoutMs?: number } = {}
): Promise<{ body: ReadableStream<Uint8Array>; source: 'helia' }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS
  const helia = await getHelia()
  const root = CID.parse(cid)
  const { car: createCarExporter } = await import('@helia/car')
  const exporter = createCarExporter(helia)
  const signal = AbortSignal.timeout(timeoutMs)

  const iter = exporter.export(root, { signal })
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iter.next()
        if (done === true) {
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (err) {
        controller.error(err)
      }
    },
    async cancel() {
      await iter.return?.(undefined)
    },
  })

  return { body, source: 'helia' }
}
