/**
 * Usage signals for the hosted console, sent to Plausible's events API with
 * a plain fetch (verified: plausible/docs docs/events-api.md POST /api/event,
 * body {name, url, domain}, 202 on success). The page's CSP allows no remote
 * script origins because session signing material lives here (see
 * vite.config.ts), so the official Plausible script tag is not an option; a
 * fetch fits the existing `connect-src https:`. The text/plain content type
 * keeps the POST a simple request with no CORS preflight, and the endpoint
 * parses the body as JSON regardless.
 *
 * Only the hosted deployment reports: a `serve` daemon (backend `local`) and
 * dev builds never send, and the hostname allowlist keeps self-hosted copies
 * of the static build from writing into the launch dashboard. The Plausible
 * site `ipfsto.filecoin.cloud` must exist before data flows; traffic from
 * the pre-cutover github.io host reports into that same site.
 */

import type { Capabilities } from 'ipfs2foc-core/capabilities'

export const ANALYTICS_DOMAIN = 'ipfsto.filecoin.cloud'
export const REPORTING_HOSTS = ['ipfsto.filecoin.cloud', 'filozone.github.io']

const PLAUSIBLE_EVENT_URL = 'https://plausible.io/api/event'

/** The reporting gate, pure so tests cover every leg without a browser. */
export function shouldReport(backend: Capabilities['backend'], isProdBuild: boolean, hostname: string): boolean {
  return backend === 'hosted' && isProdBuild && REPORTING_HOSTS.includes(hostname)
}

export function eventPayload(name: string, url: string): string {
  return JSON.stringify({ name, url, domain: ANALYTICS_DOMAIN })
}

let enabled = false
const sent = new Set<string>()

export function initAnalytics(caps: Pick<Capabilities, 'backend'>): void {
  enabled = shouldReport(caps.backend, import.meta.env.PROD, window.location.hostname)
  if (enabled) send('pageview')
}

/**
 * Fire a named event once per page load. The steer notice can flip on and
 * off while the operator edits the input; the funnel wants people, not
 * renders.
 */
export function trackOnce(name: string): void {
  if (!enabled || sent.has(name)) return
  sent.add(name)
  send(name)
}

function send(name: string): void {
  void fetch(PLAUSIBLE_EVENT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: eventPayload(name, window.location.href),
    keepalive: true,
  }).catch(() => {
    // Best effort: an ad blocker or offline tab must never surface an error.
  })
}
