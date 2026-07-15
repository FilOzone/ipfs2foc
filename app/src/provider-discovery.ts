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

interface RoutingProvider {
  Schema?: string
  Protocols?: string[]
  Addrs?: string[]
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

/**
 * Base URLs of providers that advertise the trustless-gateway HTTP transport
 * for this CID, best first, at most MAX_CAR_SOURCES. Empty on any failure.
 */
export async function discoverCarSources(cid: string, signal?: AbortSignal): Promise<string[]> {
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  const combined = signal == null ? timeout : AbortSignal.any([signal, timeout])
  try {
    const res = await fetch(`${ROUTING_ENDPOINT}/${cid}`, {
      headers: { accept: 'application/json' },
      signal: combined,
    })
    if (!res.ok) return []
    const body = (await res.json()) as { Providers?: RoutingProvider[] | null }
    const urls: string[] = []
    for (const p of body.Providers ?? []) {
      if (!(p.Protocols ?? []).includes('transport-ipfs-gateway-http')) continue
      for (const addr of p.Addrs ?? []) {
        const url = multiaddrToHttpsUrl(addr)
        if (url != null && !urls.includes(url)) urls.push(url)
        if (urls.length >= MAX_CAR_SOURCES) return urls
      }
    }
    return urls
  } catch {
    return []
  }
}
