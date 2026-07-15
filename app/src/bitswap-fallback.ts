// Bitswap-over-WebSockets block rescue for prepare (#59). When no HTTP
// source can serve a root — every CAR candidate failed and the gateway's
// per-block raw fetch failed too — the root's own peers often still can:
// providers publish browser-dialable listeners (`/tls/ws` via AutoTLS,
// plain `/wss`), and a bitswap want to a connected peer needs no routing.
//
// Peers are dialed explicitly from the addrs discovery already returned for
// the root. The routed broker path (helia routers + provider selection) is
// deliberately not used: measured against this corpus it trips over stale
// provider records and empty Protocols fields, while a direct dial to the
// same peers answers in a few hundred milliseconds.
//
// Everything is loaded lazily through dynamic import — the libp2p stack is
// its own chunk, fetched the first time a run actually needs the rescue —
// and the node is recycled once its blockstore has accumulated
// BLOCKSTORE_RECYCLE_BYTES, since helia's MemoryBlockstore retains every
// fetched block until the node is dropped.
import { blockToBytes } from 'ipfs2foc-core/block-source'
import type { CID } from 'multiformats/cid'

interface BitswapNode {
  getBlock(cid: CID, signal?: AbortSignal): Promise<Uint8Array>
  dial(addr: string, signal?: AbortSignal): Promise<void>
  stop(): Promise<void>
  storedBytes(): number
}

const DIAL_TIMEOUT_MS = 15_000
const BLOCKSTORE_RECYCLE_BYTES = 128 * 1024 * 1024

let handle: Promise<BitswapNode> | null = null

async function buildNode(): Promise<BitswapNode> {
  const [
    { createLibp2p },
    { Helia },
    { bitswap },
    { MemoryBlockstore },
    { MemoryDatastore },
    { webSockets },
    { noise },
    { yamux },
    { identify, identifyPush },
    { ping },
    { multiaddr },
  ] = await Promise.all([
    import('libp2p'),
    import('@helia/utils'),
    import('@helia/block-brokers'),
    import('blockstore-core'),
    import('datastore-core'),
    import('@libp2p/websockets'),
    import('@chainsafe/libp2p-noise'),
    import('@libp2p/yamux'),
    import('@libp2p/identify'),
    import('@libp2p/ping'),
    import('@multiformats/multiaddr'),
  ])

  const libp2p = await createLibp2p({
    addresses: { listen: [] },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), identifyPush: identifyPush(), ping: ping() },
  })

  // Count what the blockstore retains so the node can be recycled before a
  // long run turns the rescue path into a leak.
  let stored = 0
  const blockstore = new MemoryBlockstore()
  const originalPut = blockstore.put.bind(blockstore)
  blockstore.put = (cid, block, options) => {
    if (block instanceof Uint8Array) stored += block.byteLength
    return originalPut(cid, block, options)
  }

  const helia = new Helia({
    libp2p,
    datastore: new MemoryDatastore(),
    blockstore,
    blockBrokers: [bitswap()],
    // No routers: peers come from the root's own discovery record and a
    // want to a connected peer needs nothing else.
    routers: [],
  })
  await helia.start()

  return {
    async getBlock(cid: CID, signal?: AbortSignal) {
      return await blockToBytes(await helia.blockstore.get(cid, { signal }))
    },
    async dial(addr: string, signal?: AbortSignal) {
      // libp2p reuses an existing connection to the same peer, so dialing
      // per block is a no-op after the first.
      const timeout = AbortSignal.timeout(DIAL_TIMEOUT_MS)
      await libp2p.dial(multiaddr(addr), {
        signal: signal == null ? timeout : AbortSignal.any([signal, timeout]),
      })
    },
    stop: () => helia.stop(),
    storedBytes: () => stored,
  }
}

async function node(): Promise<BitswapNode> {
  handle ??= buildNode()
  const n = await handle
  if (n.storedBytes() >= BLOCKSTORE_RECYCLE_BYTES) {
    handle = buildNode()
    void n.stop().catch(() => {
      // best-effort teardown; the replacement node is already building
    })
    return await handle
  }
  return n
}

/**
 * Fetch one block over bitswap from the root's own peers. `addrs` are the
 * browser-dialable multiaddrs discovery returned for the root; at least one
 * must dial for the want to have anywhere to go. The returned bytes are
 * hash-verified by bitswap itself, and the caller (CarStreamSource gap-fill)
 * verifies them again before serving.
 */
export async function fetchBlockViaBitswap(addrs: string[], cid: CID, signal?: AbortSignal): Promise<Uint8Array> {
  if (addrs.length === 0) throw new Error('no browser-dialable peers advertised for this root')
  const n = await node()
  const dials = await Promise.allSettled(addrs.map((a) => n.dial(a, signal)))
  if (!dials.some((d) => d.status === 'fulfilled')) {
    const first = dials.find((d): d is PromiseRejectedResult => d.status === 'rejected')
    throw new Error(`no bitswap peer reachable for this root: ${String(first?.reason ?? 'dial failed')}`)
  }
  return await n.getBlock(cid, signal)
}
