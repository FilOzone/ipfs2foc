/**
 * Error reporting for the hosted console, behind the same gate as every
 * other emitter. The SDK is bundled, not loaded from a Sentry CDN — the
 * page's CSP allows no remote script origins (see vite.config.ts); the
 * ingest POST fits `connect-src https:`. The DSN arrives via build env
 * (VITE_SENTRY_DSN) and points at the BetterStack Sentry-compatible ingest,
 * same backend filecoin-pin reports to (verified: filecoin-pin
 * src/instrument.ts); absent DSN means error reporting is off.
 *
 * Payload hygiene: CIDs and wallet addresses are the operator's data, not
 * ours. `redactUserData` rewrites them out of every message, exception
 * value, and breadcrumb before anything leaves the page; filecoin-pin's
 * `sendDefaultPii: false` is kept on top of that.
 */

// Optional chain: node's test runner imports this module for redactUserData
// and has no import.meta.env.
const SENTRY_DSN = import.meta.env?.VITE_SENTRY_DSN as string | undefined

// CIDv0 (Qm + 44 base58), CIDv1/pieceCID (base32, long), 0x addresses.
const CID_V0 = /\bQm[1-9A-HJ-NP-Za-km-z]{44}\b/g
const CID_V1 = /\bba[a-z2-7]{20,}\b/g
const HEX_ADDRESS = /\b0x[0-9a-fA-F]{40,}\b/g

export function redactUserData(text: string): string {
  return text.replace(CID_V0, '[cid]').replace(CID_V1, '[cid]').replace(HEX_ADDRESS, '[address]')
}

export async function initErrorTracking(appVersion: string): Promise<void> {
  if (SENTRY_DSN == null || SENTRY_DSN === '') return
  const Sentry = await import('@sentry/browser')
  Sentry.init({
    dsn: SENTRY_DSN,
    sendDefaultPii: false,
    // Errors only; no performance tracing from end-user browsers.
    tracesSampleRate: 0,
    beforeSend(event) {
      if (event.message != null) event.message = redactUserData(event.message)
      for (const ex of event.exception?.values ?? []) {
        if (ex.value != null) ex.value = redactUserData(ex.value)
      }
      if (event.request?.url != null) event.request.url = redactUserData(event.request.url)
      return event
    },
    beforeBreadcrumb(crumb) {
      if (crumb.message != null) crumb.message = redactUserData(crumb.message)
      if (typeof crumb.data?.url === 'string') crumb.data.url = redactUserData(crumb.data.url)
      return crumb
    },
  })
  Sentry.setTag('ipfs2focVersion', appVersion)
}
