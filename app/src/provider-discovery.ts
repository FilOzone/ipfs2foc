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

// A migration inventory overwhelmingly lives on one provider set, so once a
// gateway answer dominates the real lookups it is reused instead of asked
// again — the reuse spares the routing endpoint millions of lookups on a
// large run. Reuse can never be wrong in a way that matters: every block is
// hash-verified regardless of source, and a source that lacks a root fails
// fast into the next race tier. Roots that fail anyway come back through a
// fresh lookup (`fresh`), and while an answer is learned every
// LEARNED_REVALIDATE_EVERY-th call still asks for real, so a corpus that
// shifts providers mid-run loses the learned answer within one stripe.
//
// Only the gateway URLs are learned. Measured against this corpus, the peer
// records jitter per root — address subsets and order from the same peer
// vary, and an occasional answer drops the gateway record — so learning
// keys on `carUrls` alone and tolerates a minority of divergent answers
// (majority tally, not a consecutive streak). A cached answer carries no
// p2p addrs; the rare root that needed the bitswap rescue fails its HTTP
// tiers, and its retry does a fresh lookup that restores them.
const LEARN_AFTER = 20
const LEARN_MAJORITY = 0.8
const LEARNED_REVALIDATE_EVERY = 50
// Halve the tally at this many real answers so an old majority cannot
// outvote a genuine mid-run shift forever.
const TALLY_DECAY_AT = 200

let learned: string[] | null = null
let learnedKey: string | null = null
let learnedUses = 0
const tally = new Map<string, { count: number; carUrls: string[] }>()
let answers = 0

/** Learn from a successful routing answer's gateway URLs. */
function learn(carUrls: string[]): void {
  const key = JSON.stringify(carUrls)
  const entry = tally.get(key) ?? { count: 0, carUrls: [...carUrls] }
  entry.count++
  tally.set(key, entry)
  answers++
  if (answers >= TALLY_DECAY_AT) {
    answers = 0
    for (const [k, e] of tally) {
      e.count = Math.floor(e.count / 2)
      if (e.count === 0) tally.delete(k)
      else answers += e.count
    }
  }
  let best: { key: string; count: number; carUrls: string[] } | null = null
  for (const [k, e] of tally) {
    if (best == null || e.count > best.count) best = { key: k, count: e.count, carUrls: e.carUrls }
  }
  if (best != null && best.count >= LEARN_AFTER && best.count / answers >= LEARN_MAJORITY) {
    learned = best.carUrls
    learnedKey = best.key
  } else if (learnedKey != null && (tally.get(learnedKey)?.count ?? 0) / answers < LEARN_MAJORITY) {
    learned = null
    learnedKey = null
  }
}

const learnedSources = (): RootSources => ({ carUrls: [...(learned ?? [])], p2pAddrs: [] })

/**
 * Everything one routing lookup offers for this root: trustless-gateway base
 * URLs (at most MAX_CAR_SOURCES) and browser-dialable bitswap addrs (at most
 * MAX_P2P_ADDRS). Empty lists on any failure. Once one gateway answer
 * dominates the real lookups it is returned without a lookup; `fresh`
 * forces a real lookup for this root regardless.
 */
export async function discoverRootSources(cid: string, signal?: AbortSignal, fresh = false): Promise<RootSources> {
  if (!fresh && learned != null && ++learnedUses % LEARNED_REVALIDATE_EVERY !== 0) {
    return learnedSources()
  }
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  const combined = signal == null ? timeout : AbortSignal.any([signal, timeout])
  try {
    const res = await fetch(`${ROUTING_ENDPOINT}/${cid}`, {
      headers: { accept: 'application/json' },
      signal: combined,
    })
    // A non-OK or failed lookup teaches nothing: only a real routing answer
    // (including a genuinely empty one) counts toward the tally, so an
    // endpoint outage can neither build nor tear down confidence.
    if (!res.ok) return learned != null && !fresh ? learnedSources() : EMPTY
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
    learn(carUrls)
    return { carUrls, p2pAddrs }
  } catch {
    return learned != null && !fresh ? learnedSources() : EMPTY
  }
}
