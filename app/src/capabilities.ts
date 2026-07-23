/**
 * Backend discovery. On startup the console asks its own origin
 * `GET /api/capabilities` (the contract lives in `ipfs2foc-core/capabilities`).
 * The CLI `serve` daemon answers and the console becomes its control plane;
 * anywhere else — the hosted static site, a dev server — the request 404s and
 * the console falls back to the hosted defaults below. The fallback must
 * survive weird responses (a proxy's HTML 404 page served with status 200),
 * so the gate checks status, content type, and schema before trusting it.
 */

import { CAPABILITIES_SCHEMA_VERSION, type Capabilities } from 'ipfs2foc-core/capabilities'

/**
 * The network the hosted console starts on. A `serve` daemon declares its own
 * and the console follows it; on the hosted site the operator picks, starting
 * here. Set to 'mainnet' for launch.
 */
export const DEFAULT_NETWORK = 'calibration' as const

/** What the static hosted console can do: in-browser prepare + wallet signing. */
export const HOSTED_DEFAULTS: Capabilities = {
  schemaVersion: CAPABILITIES_SCHEMA_VERSION,
  backend: 'hosted',
  network: DEFAULT_NETWORK,
  apiBase: null,
  // Providers pull gateway CAR URLs directly (any HTTPS URL is a valid pull
  // source; the provider recomputes commP over the bytes). pieceBase is a
  // serve daemon's own /piece origin — the hosted site has none.
  pieceBase: null,
  supportsAssembledPieces: false,
  supportsServerCommp: false,
  supportsBrowserSigning: true,
  requiresPublicIngress: false,
}

export async function loadCapabilities(): Promise<Capabilities> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}api/capabilities`)
    if (!res.ok) return HOSTED_DEFAULTS
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return HOSTED_DEFAULTS
    const caps = (await res.json()) as Capabilities
    if (caps.schemaVersion !== CAPABILITIES_SCHEMA_VERSION) return HOSTED_DEFAULTS
    if (caps.backend !== 'local' && caps.backend !== 'hosted') return HOSTED_DEFAULTS
    if (caps.network !== 'mainnet' && caps.network !== 'calibration') return HOSTED_DEFAULTS
    return caps
  } catch {
    return HOSTED_DEFAULTS
  }
}
