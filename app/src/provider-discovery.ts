// Per-root retrieval spread for prepare (#59). The network's own providers
// advertise trustless HTTP gateways through delegated routing; asking there
// first pulls each root from a host that actually holds the content and
// keeps the configured gateway as the fallback instead of the funnel every
// byte must pass through. Discovery is best-effort by construction: any
// failure, timeout, or empty answer means the candidate list is empty and
// the prepare proceeds exactly as before.
//
// Every block from a discovered host goes through the same hash verification
// as gateway blocks (CarStreamSource), so a provider can be wrong or
// malicious without affecting the run beyond a retry — and the commitment is
// a pure function of the content, so where the bytes came from can never
// change a PieceCID.

const ROUTING_ENDPOINT = 'https://delegated-ipfs.dev/routing/v1/providers'
// Discovery must never become the slow path: a root whose lookup dawdles
// just goes straight to the configured gateway.
const DISCOVERY_TIMEOUT_MS = 5_000
// Candidates actually tried per root before the configured gateway. One
// provider covers the common single-origin inventory; a second absorbs a
// flaky first without turning failover into a tour.
const MAX_CAR_SOURCES = 2

// Bitswap peers actually tried per root. One AutoTLS/wss listener is the
// common case; a second covers a stale first record.
const MAX_P2P_ADDRS = 4

interface RoutingProvider {
  Schema?: string
  ID?: string
  Protocols?: string[]
  Addrs?: string[]
}

export interface RootSources {
  /** Trustless-gateway base URLs to try for the whole-root CAR, best first. */
  carUrls: string[]
  /**
   * Browser-dialable bitswap multiaddrs (`/tls/ws`, `/wss`), peer id
   * included — the per-block rescue when no HTTP source can serve the root.
   * Dialed explicitly: on this corpus the routed broker path trips over
   * stale records and empty Protocols fields, while a direct dial to the
   * same peers just works.
   */
  p2pAddrs: string[]
}

/**
 * An https base URL from a gateway-ish multiaddr, or null. Plain-http
 * candidates are dropped: the console runs on https pages, where
 * mixed-content fetches are blocked anyway.
 */
export function multiaddrToHttpsUrl(addr: string): string | null {
  const m = addr.match(/^\/dns[46]?\/([^/]+)(?:\/tcp\/(\d+))?\/(?:https|tls\/http)(?:\/|$)/)
  if (m == null) return null
  const [, host, port] = m
  return port != null && port !== '443' ? `https://${host}:${port}` : `https://${host}`
}

/** True for a multiaddr a browser websocket transport can dial. */
function isBrowserDialable(addr: string): boolean {
  return /\/(wss|tls\/ws)(\/|$)/.test(addr)
}

const EMPTY: RootSources = { carUrls: [], p2pAddrs: [] }

/**
 * Everything one routing lookup offers for this root: trustless-gateway base
 * URLs (at most MAX_CAR_SOURCES) and browser-dialable bitswap addrs (at most
 * MAX_P2P_ADDRS). Empty lists on any failure.
 */
export async function discoverRootSources(cid: string, signal?: AbortSignal): Promise<RootSources> {
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  const combined = signal == null ? timeout : AbortSignal.any([signal, timeout])
  try {
    const res = await fetch(`${ROUTING_ENDPOINT}/${cid}`, {
      headers: { accept: 'application/json' },
      signal: combined,
    })
    if (!res.ok) return EMPTY
    const body = (await res.json()) as { Providers?: RoutingProvider[] | null }
    const carUrls: string[] = []
    const p2pAddrs: string[] = []
    for (const p of body.Providers ?? []) {
      if ((p.Protocols ?? []).includes('transport-ipfs-gateway-http')) {
        for (const addr of p.Addrs ?? []) {
          const url = multiaddrToHttpsUrl(addr)
          if (url != null && carUrls.length < MAX_CAR_SOURCES && !carUrls.includes(url)) carUrls.push(url)
        }
        continue
      }
      // Anything else is a peer record: keep the addrs a browser can dial.
      // Protocols is unreliable here (real bitswap servers publish []), so
      // dialability is the filter and the bitswap want is the probe.
      if (p.ID == null) continue
      for (const addr of p.Addrs ?? []) {
        if (!isBrowserDialable(addr)) continue
        const full = addr.includes('/p2p/') ? addr : `${addr}/p2p/${p.ID}`
        if (p2pAddrs.length < MAX_P2P_ADDRS && !p2pAddrs.includes(full)) p2pAddrs.push(full)
      }
    }
    return { carUrls, p2pAddrs }
  } catch {
    return EMPTY
  }
}
