/**
 * The wallet step as a checklist. Each row reports its real state; the first
 * unmet row is the blocker and everything after it waits. Pure derivations so
 * the row states and the funding funnel signals are testable without a DOM.
 */

import { fmtToken, type PaymentsStatus } from './payments.ts'

/**
 * Heuristic gas floor for the wallet's setup transactions (deposit, approve,
 * data set creation). Not a protocol number: FEVM message fees vary, this is
 * a comfortable margin above what the handful of setup messages costs, so a
 * wallet under it gets a clear "add FIL" row instead of a mid-flow revert.
 */
export const FIL_GAS_FLOOR = 10n ** 16n // 0.01 FIL

export type FundingRowId = 'wallet' | 'connect' | 'fil' | 'usdfc' | 'approve' | 'signing'

export type FundingRowState = 'done' | 'blocked' | 'waiting'

export interface FundingRow {
  id: FundingRowId
  title: string
  state: FundingRowState
  /** Balance-vs-required or other short status; null when the title says it all. */
  detail: string | null
}

export interface FundingInputs {
  /** An injected wallet extension exists in this browser. */
  providerDetected: boolean
  /** The wallet is connected. */
  connected: boolean
  /** Connected on the network this run targets. */
  onTargetNetwork: boolean
  /** Target network label for row copy, e.g. "Mainnet". */
  networkLabel: string
  /** Read-only payment state; null until the first read lands. */
  payments: PaymentsStatus | null
  /** USDFC the run needs available (the cost-gate estimate); null while unknown. */
  requiredUsdfc: bigint | null
  /** A signing session exists and is usable. */
  signingEnabled: boolean
  /** Symbol for the gas token row ("FIL" / "tFIL"). */
  filSymbol: string
}

/**
 * The six rows in order. The first row that is not satisfied is `blocked`
 * (its action is the one thing to do next); rows after it are `waiting`.
 * Rows that cannot be judged yet (payments unread) count as unsatisfied so
 * the operator never sees a green row that could still fail.
 */
export function fundingChecklist(x: FundingInputs): FundingRow[] {
  const usdfcNeed = x.requiredUsdfc ?? 0n
  const p = x.payments
  const checks: Array<{ id: FundingRowId; title: string; ok: boolean; detail: string | null }> = [
    {
      id: 'wallet',
      title: 'Wallet extension',
      ok: x.providerDetected,
      detail: x.providerDetected ? null : 'No wallet extension found in this browser',
    },
    {
      id: 'connect',
      title: x.connected && !x.onTargetNetwork ? `Connected on ${x.networkLabel}` : 'Wallet connected',
      ok: x.connected && x.onTargetNetwork,
      detail: x.connected && !x.onTargetNetwork ? `The wallet is on another network` : null,
    },
    {
      id: 'fil',
      title: `${x.filSymbol} for gas`,
      ok: p != null && p.fil >= FIL_GAS_FLOOR,
      detail:
        p == null
          ? 'reading balances…'
          : `${fmtToken(p.fil, x.filSymbol)} of ≈${fmtToken(FIL_GAS_FLOOR, x.filSymbol)} needed`,
    },
    {
      id: 'usdfc',
      title: 'USDFC deposited',
      ok: p != null && p.availableUsdfc >= usdfcNeed && p.availableUsdfc > 0n,
      detail:
        p == null
          ? 'reading balances…'
          : `${fmtToken(p.availableUsdfc, 'USDFC')} available` +
            (x.requiredUsdfc == null ? '' : ` of ≈${fmtToken(usdfcNeed, 'USDFC')} needed`) +
            (p.availableUsdfc < usdfcNeed && p.walletUsdfc > 0n
              ? ` · ${fmtToken(p.walletUsdfc, 'USDFC')} in the wallet, not yet deposited`
              : ''),
    },
    {
      id: 'approve',
      title: 'Storage operator approved',
      ok: p?.operatorApproved === true,
      detail: p == null ? 'reading approval…' : null,
    },
    {
      id: 'signing',
      title: 'Signing enabled',
      ok: x.signingEnabled,
      detail: null,
    },
  ]

  let blockedSeen = false
  return checks.map((c) => {
    if (c.ok) return { id: c.id, title: c.title, state: 'done', detail: c.detail }
    const state: FundingRowState = blockedSeen ? 'waiting' : 'blocked'
    blockedSeen = true
    return { id: c.id, title: c.title, state, detail: c.detail }
  })
}

/**
 * The funnel names for wallet-step drop-off. Derived from the same inputs as
 * the checklist so the dashboards and the UI can never disagree about which
 * blocker the operator is on. `signing-declined` is event-driven (a failed
 * grant), not state-derived, and is reported at the failure site.
 */
export type FundingState =
  | 'wallet-none'
  | 'wallet-connected'
  | 'no-fil'
  | 'no-usdfc'
  | 'not-approved'
  | 'signing-enabled'

export function deriveFundingState(x: FundingInputs): FundingState | null {
  if (!x.providerDetected) return 'wallet-none'
  if (!x.connected || !x.onTargetNetwork) return null
  if (x.signingEnabled) return 'signing-enabled'
  const p = x.payments
  if (p == null) return 'wallet-connected'
  if (p.fil < FIL_GAS_FLOOR) return 'no-fil'
  const need = x.requiredUsdfc ?? 0n
  if (p.availableUsdfc < need || p.availableUsdfc === 0n) return 'no-usdfc'
  if (!p.operatorApproved) return 'not-approved'
  return 'wallet-connected'
}
