/**
 * Run ceilings for the hosted console, sized so a run finishes in under ten
 * minutes. Measured on the corpus behind #62: chunk commits are sequential
 * 32-piece AddPieces transactions at about a minute each including
 * confirmation, and the one measured provider pull ran 0.18 MiB/s. Re-measure
 * pull throughput before treating these as protocol facts.
 *
 * A `serve` daemon (capabilities backend `local`) runs uncapped; the limits
 * bind only on the static hosted deployment. Larger sets belong on the CLI.
 */

import type { Capabilities } from 'ipfs2foc-core/capabilities'

export const HOSTED_MAX_CIDS = 500
export const HOSTED_MAX_RUN_BYTES = 100 * 1024 * 1024

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
