/**
 * Run ceilings for the hosted console. The count cap protects the provider:
 * every item is a proving-set entry the SP carries for the life of the data
 * set. The byte ceiling sits at the piece/upload unit, one aggregate's worth;
 * Curio parks a piece of at most about 1 GiB, so a run past this cannot ship
 * as a single piece anyway. Wall-clock is not capped: the live estimate
 * carries that instead, and a run projected past LONG_RUN_ADVISORY_SECONDS
 * gets a non-blocking long-run note.
 *
 * A `serve` daemon (capabilities backend `local`) runs uncapped; the limits
 * bind only on the static hosted deployment. Larger sets belong on the CLI.
 */

import type { Capabilities } from 'ipfs2foc-core/capabilities'

export const HOSTED_MAX_CIDS = 500
export const HOSTED_MAX_RUN_BYTES = 1024 * 1024 * 1024

export interface RunLimits {
  maxCids: number
  maxBytes: number
}

/** The limits for this deployment, or null when the backend is uncapped. */
export function runLimits(caps: Pick<Capabilities, 'backend'>): RunLimits | null {
  if (caps.backend !== 'hosted') return null
  return { maxCids: HOSTED_MAX_CIDS, maxBytes: HOSTED_MAX_RUN_BYTES }
}

export function overCidCap(count: number, limits: RunLimits | null): boolean {
  return limits != null && count > limits.maxCids
}

export function overByteCap(preparedBytes: number, limits: RunLimits | null): boolean {
  return limits != null && preparedBytes > limits.maxBytes
}

/** A hosted run projected past this many seconds gets the long-run note. */
export const LONG_RUN_ADVISORY_SECONDS = 10 * 60

/**
 * Latch for the long-run note: once a run's projection crosses the threshold
 * the note stays up for the rest of the run, even if the estimate later dips
 * back under it. A note that blinks in and out with the rate reads as a
 * glitch, not advice.
 */
export function latchLongRun(latched: boolean, projectedSecondsLeft: number | null): boolean {
  return latched || (projectedSecondsLeft != null && projectedSecondsLeft > LONG_RUN_ADVISORY_SECONDS)
}

/**
 * Seconds left in a submit, from committed-chunk counts sampled over time.
 * Needs two samples with at least one commit between them; before that the
 * caller shows no estimate rather than a made-up one.
 */
export function chunkEtaSeconds(samples: ReadonlyArray<{ t: number; n: number }>, remaining: number): number | null {
  if (samples.length < 2 || remaining <= 0) return null
  const first = samples[0]
  const last = samples[samples.length - 1]
  const gained = last.n - first.n
  const elapsed = (last.t - first.t) / 1000
  if (gained < 1 || elapsed <= 0) return null
  return remaining / (gained / elapsed)
}
