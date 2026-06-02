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
 * (UPnP / AutoTLS) is required for outbound bitswap, so the node listens on no
 * addresses at all.
 *
 * Why this assembles libp2p by hand instead of using `helia`'s `createHelia` /
 * `libp2pDefaults`: importing the `helia` barrel statically pulls
 * `@libp2p/webrtc` → `node-datachannel`, whose native binding is not prebuilt
 * for Node 26 and throws at *import* time (#18). A runtime transport filter
 * cannot help — the crash happens before any config runs. We therefore build
 * the node from `@helia/utils`' `Helia` class with a libp2p composed only of
 * the transports we actually dial (TCP, WebSockets). WebRTC never enters the
 * module graph. Provider discovery is delegated routing over HTTP, and gateway
 * routing covers the trustless-gateway broker — neither needs a native module.
 */

import { CID } from 'multiformats/cid'

// `Helia<T extends Libp2p>` is parameterised by the libp2p service map; we
// build libp2p dynamically, so `any` here just means "whatever services that
// node ends up with" — the fallback never reaches into typed services.
type HeliaInstance = import('@helia/utils').Helia<any>

/**
 * Build the libp2p init for the embedded node.
 *
 * Outbound-only: no listen addresses, so no inbound transports, no NAT
 * traversal, and — critically — no WebRTC. Transports are TCP and WebSockets,
 * which together reach the overwhelming majority of public bitswap providers
 * and trustless gateways advertised via delegated routing.
 *
 * Exported so `test/helia-config.test.ts` can assert the WebRTC-free shape
 * without standing up a node.
 */
export async function buildLibp2pConfig(): Promise<Record<string, any>> {
  // Dynamic imports keep the module load cheap for runs that never engage the
  // fallback. None of these pull a native binding.
  const { tcp } = await import('@libp2p/tcp')
  const { webSockets } = await import('@libp2p/websockets')
  const { noise } = await import('@chainsafe/libp2p-noise')
  const { yamux } = await import('@libp2p/yamux')
  const { identify, identifyPush } = await import('@libp2p/identify')
  const { ping } = await import('@libp2p/ping')

  return {
    // Outbound-only: dial, never listen.
    addresses: { listen: [] },
    transports: [tcp(), webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      identifyPush: identifyPush(),
      ping: ping(),
    },
  }
}

/** Default upper bound on a fallback fetch. The CLI exposes this as `--ipfs-fallback-timeout-seconds`. */
export const DEFAULT_FALLBACK_TIMEOUT_MS = 120_000

let heliaPromise: Promise<HeliaInstance> | null = null

/**
 * Lazily construct and start a Helia node. The first caller pays the startup
 * cost; subsequent callers share the same node for the lifetime of the process.
 *
 * The node is assembled from `@helia/utils` rather than `helia` to keep WebRTC
 * out of the import graph (see the module header). Block brokers are the
 * trustless-gateway HTTP broker and bitswap; routers are delegated routing
 * (provider discovery over HTTP) and gateway routing (gateway discovery for
 * the trustless-gateway broker).
 */
export async function getHelia(): Promise<HeliaInstance> {
  if (heliaPromise == null) {
    heliaPromise = (async () => {
      const { createLibp2p } = await import('libp2p')
      const { Helia } = await import('@helia/utils')
      const { trustlessGateway, bitswap } = await import('@helia/block-brokers')
      const { libp2pRouting, httpGatewayRouting, delegatedHTTPRouting, delegatedHTTPRoutingDefaults } =
        await import('@helia/routers')
      const { MemoryBlockstore } = await import('blockstore-core')
      const { MemoryDatastore } = await import('datastore-core')

      const libp2p = await createLibp2p(await buildLibp2pConfig())

      const helia = new Helia({
        libp2p,
        datastore: new MemoryDatastore(),
        blockstore: new MemoryBlockstore(),
        blockBrokers: [trustlessGateway(), bitswap()],
        routers: [
          libp2pRouting(libp2p),
          httpGatewayRouting(),
          delegatedHTTPRouting(delegatedHTTPRoutingDefaults()),
        ],
      })
      await helia.start()
      return helia
    })()
  }
  return heliaPromise
}

/**
 * Tear down the Helia node if one was started. Safe to call when no node was
 * ever created (e.g. fallback never fired during the run). `Helia.stop()` also
 * stops the underlying libp2p node.
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
