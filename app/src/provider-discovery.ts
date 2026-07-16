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

// A migration inventory overwhelmingly lives on one provider set, so after
// this many consecutive identical routing answers the answer is reused
// instead of asked again — the reuse spares the routing endpoint millions of
// lookups on a large run. Reuse can never be wrong in a way that matters:
// every block is hash-verified regardless of source, and a source that lacks
// a root fails fast into the next race tier. Roots that fail anyway come
// back through a fresh lookup (`fresh`), and while the answer is learned
// every LEARNED_REVALIDATE_EVERY-th call still asks for real, so a corpus
// that shifts providers mid-run drops the learned answer within one stripe.
const LEARN_AFTER = 20
const LEARNED_REVALIDATE_EVERY = 50

let learned: RootSources | null = null
let lastKey: string | null = null
let streak = 0
let learnedUses = 0

const copyOf = (s: RootSources): RootSources => ({ carUrls: [...s.carUrls], p2pAddrs: [...s.p2pAddrs] })

/** Learn from a successful routing answer; one differing answer forgets. */
function learn(result: RootSources): void {
  const key = JSON.stringify([result.carUrls, result.p2pAddrs])
  if (key === lastKey) {
    streak++
  } else {
    lastKey = key
    streak = 1
    learned = null
  }
  if (streak >= LEARN_AFTER) learned = copyOf(result)
}

/**
 * Everything one routing lookup offers for this root: trustless-gateway base
 * URLs (at most MAX_CAR_SOURCES) and browser-dialable bitswap addrs (at most
 * MAX_P2P_ADDRS). Empty lists on any failure. Once the corpus has answered
 * identically LEARN_AFTER times in a row the learned answer is returned
 * without a lookup; `fresh` forces a real lookup for this root regardless.
 */
export async function discoverRootSources(cid: string, signal?: AbortSignal, fresh = false): Promise<RootSources> {
  if (!fresh && learned != null && ++learnedUses % LEARNED_REVALIDATE_EVERY !== 0) {
    return copyOf(learned)
  }
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  const combined = signal == null ? timeout : AbortSignal.any([signal, timeout])
  try {
    const res = await fetch(`${ROUTING_ENDPOINT}/${cid}`, {
      headers: { accept: 'application/json' },
      signal: combined,
    })
    // A non-OK or failed lookup teaches nothing: only a real routing answer
    // (including a genuinely empty one) counts toward the learned streak, so
    // an endpoint outage can neither build nor tear down confidence.
    if (!res.ok) return learned != null && !fresh ? copyOf(learned) : EMPTY
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
    const result = { carUrls, p2pAddrs }
    learn(result)
    return result
  } catch {
    return learned != null && !fresh ? copyOf(learned) : EMPTY
  }
}
