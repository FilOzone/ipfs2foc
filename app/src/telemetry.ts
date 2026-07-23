/**
 * Operational funnel telemetry for the hosted console. Everything here keys
 * off the analytics gate (`analyticsEnabled`): a `serve` daemon, a dev build,
 * or a self-hosted copy emits nothing, same as the Plausible events.
 *
 * Three emitters share the derived funnel state:
 * - Plausible events with small bucketed props (people-level funnel);
 * - BetterStack metric points, one counter per funnel-step transition,
 *   mirroring the filecoin-pin metrics body (verified: filecoin-pin
 *   src/core/telemetry/index.ts `post` — array of {name, counter|gauge,
 *   dt, tags} with a bearer token);
 * - a page-dismissal beacon carrying the step the operator left on.
 *
 * The BetterStack endpoint and token arrive via build env
 * (VITE_METRICS_ENDPOINT / VITE_METRICS_TOKEN); absent means that emitter is
 * off. The dismissal beacon goes to Plausible only — `sendBeacon` cannot set
 * an Authorization header, so the metrics endpoint is unreachable during
 * unload.
 */

import { analyticsEnabled, beaconOnce, trackOnce } from './analytics.ts'

/** Coarse funnel position, ordered. Derived, not stored — the app reports
 * its state and the step falls out. */
export type FunnelStep = 'landed' | 'input' | 'wallet' | 'preparing' | 'prepared' | 'submitting' | 'done'

export interface FunnelSnapshot {
  cidCount: number
  walletConnected: boolean
  preparing: boolean
  preparedDone: number
  prepareTotal: number
  prepareErrors: number
  submitting: boolean
  runCompleted: boolean
}

/** The latest position the snapshot supports; later stages win. */
export function deriveStep(s: FunnelSnapshot): FunnelStep {
  if (s.runCompleted) return 'done'
  if (s.submitting) return 'submitting'
  if (s.preparing) return 'preparing'
  if (s.prepareTotal > 0 && s.preparedDone + s.prepareErrors >= s.prepareTotal) return 'prepared'
  if (s.walletConnected) return 'wallet'
  if (s.cidCount > 0) return 'input'
  return 'landed'
}

/** Low-cardinality size class for the entered list. */
export function cidCountBucket(n: number): string {
  if (n <= 10) return '1-10'
  if (n <= 50) return '11-50'
  if (n <= 100) return '51-100'
  if (n <= 500) return '101-500'
  return '501+'
}

/** Which quarter milestones a completion ratio has crossed. */
export function milestonesCrossed(done: number, total: number): number[] {
  if (total <= 0) return []
  const pct = (done / total) * 100
  return [25, 50, 75, 100].filter((m) => pct >= m)
}

// Optional chain: node's test runner imports this module and has no
// import.meta.env; the emitter simply stays off there.
const METRICS_ENDPOINT = import.meta.env?.VITE_METRICS_ENDPOINT as string | undefined
const METRICS_TOKEN = import.meta.env?.VITE_METRICS_TOKEN as string | undefined

/** One counter per funnel-step transition, so dashboards read drop-off
 * between steps directly. Fire-and-forget, mirrors filecoin-pin's shape. */
function recordStepMetric(step: FunnelStep): void {
  if (METRICS_ENDPOINT == null || METRICS_TOKEN == null) return
  const body = JSON.stringify([
    { name: 'consoleFunnelStep', counter: { value: 1 }, dt: new Date().toISOString(), tags: { step } },
  ])
  void fetch(METRICS_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${METRICS_TOKEN}`, 'Content-Type': 'application/json' },
    body,
    keepalive: true,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    // Best effort: telemetry never surfaces to the operator.
  })
}

let lastSnapshot: FunnelSnapshot | null = null
let lastStep: FunnelStep | null = null
const milestonesSent = new Set<number>()

/**
 * The app calls this whenever funnel-relevant state changes; everything
 * else (dedupe, bucketing, transports) happens here so the call site stays
 * one line and the decisions stay testable.
 */
export function reportFunnelState(s: FunnelSnapshot): void {
  lastSnapshot = s
  if (!analyticsEnabled()) return

  if (s.cidCount > 0) trackOnce('cids-entered', { count: cidCountBucket(s.cidCount) })
  for (const m of milestonesCrossed(s.preparedDone, s.prepareTotal)) {
    if (milestonesSent.has(m)) continue
    milestonesSent.add(m)
    trackOnce(`prepare-${m}pct`)
  }

  const step = deriveStep(s)
  if (step !== lastStep) {
    lastStep = step
    if (step !== 'landed') recordStepMetric(step)
  }
}

/**
 * Arm the page-dismissal beacon. `pagehide` is the reliable end-of-page
 * signal (fires on close, navigation, and bfcache entry); `visibilitychange`
 * to hidden is not dismissal, so it is left alone. A load that never got
 * past landing sends nothing — the pageview already counts it.
 */
export function initAbandonBeacon(): void {
  window.addEventListener('pagehide', () => {
    if (!analyticsEnabled() || lastSnapshot == null) return
    const step = deriveStep(lastSnapshot)
    if (step === 'landed') return
    beaconOnce('page-closed', {
      step,
      cids: cidCountBucket(lastSnapshot.cidCount),
      prepared: lastSnapshot.prepareTotal > 0 ? Math.round((lastSnapshot.preparedDone / lastSnapshot.prepareTotal) * 100) : 0,
    })
  })
}
