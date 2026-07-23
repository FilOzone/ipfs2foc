/**
 * The one-active-step flow: which step owns the main column, and what the
 * history chrome shows for the steps already behind the operator. Pure
 * derivations over app state, so the transitions are testable without a DOM.
 *
 * Ordering principle (the launch journey doc): value before commitment. The
 * paste box is the whole landing; prepare runs free; the cost gate shows the
 * price before any wallet interaction; wallet and funds come last before the
 * submit itself.
 */

export type Stage = 'intake' | 'prepare' | 'cost' | 'wallet' | 'submit' | 'receipt'

const ORDER: Stage[] = ['intake', 'prepare', 'cost', 'wallet', 'submit', 'receipt']

export function stageIndex(stage: Stage): number {
  return ORDER.indexOf(stage)
}

/** What the history chrome calls each step. */
export const STAGE_TITLES: Record<Stage, string> = {
  intake: 'List',
  prepare: 'Prepare',
  cost: 'Cost',
  wallet: 'Wallet & funds',
  submit: 'Migrate',
  receipt: 'Receipt',
}

export interface FlowSnapshot {
  /** A prepare run exists (rows in the store). */
  prepareStarted: boolean
  /** A prepare run is in flight. */
  running: boolean
  /** Prepared pieces available to carry forward. */
  preparedCount: number
  /** The operator moved past the prepare results. */
  reviewedPrepare: boolean
  /** The operator accepted the cost gate. */
  costAccepted: boolean
  /** Wallet on the target network, payment setup done, session live. */
  canSign: boolean
  /** A submit run exists (live or restored from a previous visit). */
  submitStarted: boolean
  /** Every copy committed. */
  allCommitted: boolean
}

/**
 * The step that owns the main column. A restored submit wins over the
 * earlier steps: a returner lands where their run actually is, never back at
 * the paste box.
 */
export function deriveStage(s: FlowSnapshot): Stage {
  if (s.allCommitted) return 'receipt'
  if (s.submitStarted) return 'submit'
  if (!s.prepareStarted) return 'intake'
  if (s.running || s.preparedCount === 0 || !s.reviewedPrepare) return 'prepare'
  if (!s.costAccepted) return 'cost'
  if (!s.canSign) return 'wallet'
  return 'submit'
}

export interface HistoryInputs {
  cidCount: number
  preparedCount: number
  prepareTotal: number
  /** Short cost text once an estimate exists, e.g. "≈0.12 USDFC / month". */
  costLabel: string | null
  dataSetCount: number
}

export interface HistoryEntry {
  stage: Stage
  label: string
}

/**
 * One receipt line per completed step, in step order. Future steps are never
 * listed — the chrome is live state, not a table of contents.
 */
export function historyEntries(stage: Stage, x: HistoryInputs): HistoryEntry[] {
  const i = stageIndex(stage)
  const out: HistoryEntry[] = []
  if (i > stageIndex('intake')) out.push({ stage: 'intake', label: `Listed ${x.cidCount.toLocaleString()} items` })
  if (i > stageIndex('prepare')) {
    out.push({
      stage: 'prepare',
      label: `Prepared ${x.preparedCount.toLocaleString()} of ${x.prepareTotal.toLocaleString()}`,
    })
  }
  if (i > stageIndex('cost'))
    out.push({ stage: 'cost', label: x.costLabel == null ? 'Cost reviewed' : `Cost ${x.costLabel}` })
  if (i > stageIndex('wallet')) out.push({ stage: 'wallet', label: 'Signing enabled' })
  if (i > stageIndex('submit')) {
    out.push({
      stage: 'submit',
      label: x.dataSetCount === 1 ? 'Migrated, 1 data set' : `Migrated, ${x.dataSetCount} data sets`,
    })
  }
  return out
}

/** The storage rate the cost gate estimates against (read from the service contract). */
export interface StorageRate {
  pricePerTiBPerMonth: bigint
  minimumPricePerMonth: bigint
}

const TIB = 1n << 40n

/**
 * Estimated USDFC for storing `bytes` across `copies` data sets. Each copy
 * pays the larger of the size-based rate and the contract's per-data-set
 * monthly minimum. `months` parameterizes duration; the default matches the
 * ongoing per-month rail the service actually charges.
 */
export function estimateCostUsdfc(bytes: number, copies: number, rate: StorageRate, months = 1): bigint {
  if (bytes <= 0 || copies <= 0 || months <= 0) return 0n
  const sized = (BigInt(Math.ceil(bytes)) * rate.pricePerTiBPerMonth + TIB - 1n) / TIB
  const perCopy = sized > rate.minimumPricePerMonth ? sized : rate.minimumPricePerMonth
  return perCopy * BigInt(copies) * BigInt(months)
}
