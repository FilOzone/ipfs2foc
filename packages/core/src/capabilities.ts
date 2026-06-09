/**
 * The capabilities contract: what a backend serving the migration console can
 * do, as reported by `GET /api/capabilities`. The browser app fetches it on
 * startup; a 404 (or anything that fails validation) means there is no local
 * backend and the app falls back to its hosted defaults. This versioned schema
 * is the seam that lets the app and the CLI ship together today and move apart
 * later (separate app package, different host) without drifting.
 *
 * SINGLE SOURCE OF TRUTH. The CLI `serve` command produces this document and
 * `app/src/capabilities.ts` consumes it. Do not re-declare the shape elsewhere.
 *
 * ## Schema v1
 *
 * ```jsonc
 * {
 *   "schemaVersion": 1,
 *   "backend": "local" | "hosted",          // who is answering
 *   "network": "mainnet" | "calibration",   // network the backend operates on
 *   "apiBase": "/api" | null,               // control-plane API root; null = no API
 *   "pieceBase": "https://…" | null,        // base URL providers pull pieces from; null = not served here
 *   "supportsAssembledPieces": false,        // can byte-serve assembled multi-root CARs
 *   "supportsServerCommp": true,             // computes commitments server-side (vs in the browser)
 *   "supportsBrowserSigning": false,         // accepts browser-wallet session authorizations
 *   "requiresPublicIngress": false           // provider pulls need this host publicly reachable
 * }
 * ```
 *
 * Pure module — no `node:` imports, no DOM-only globals — so the browser and
 * the CLI can both import it.
 */

/** The supported capabilities schema version. Bump only on a breaking shape change. */
export const CAPABILITIES_SCHEMA_VERSION = 1

/** What a backend serving the migration console can do. */
export interface Capabilities {
  schemaVersion: typeof CAPABILITIES_SCHEMA_VERSION
  /** Who is answering: a local `serve` daemon or the hosted static app. */
  backend: 'local' | 'hosted'
  /** Network the backend operates on. The app must not mix networks. */
  network: 'mainnet' | 'calibration'
  /** Control-plane API root (same-origin path), or null when there is no API. */
  apiBase: string | null
  /** Base URL storage providers pull pieces from, or null when not served here. */
  pieceBase: string | null
  /** Can byte-serve assembled multi-root CARs (the `pack-cars` path). */
  supportsAssembledPieces: boolean
  /** Computes piece commitments server-side; the app is a control plane, not a hasher. */
  supportsServerCommp: boolean
  /** Accepts browser-wallet session authorizations for on-chain submission. */
  supportsBrowserSigning: boolean
  /** Provider pulls require this host to be publicly reachable (ingress needed). */
  requiresPublicIngress: boolean
}
