// Read-only verify-on-chain for the submit panel (#47).
//
// The chain is the only complete record of what a data set holds: commit
// receipts freeze the console's per-piece state at commit time, and a piece
// committed through another surface (the local daemon, the CLI) never shows
// up here at all. These reads reconcile the run against `getActivePieces` and
// the proof-of-possession getters — the same reads the CLI's `report` uses —
// over a public RPC, with no wallet, account, or session involved.
//
// One honest gap: a piece committed inside an assembled aggregate sits on
// chain under the AGGREGATE's PieceCID, not the member's. Without that
// aggregate's manifest the membership is unknowable here, so such members
// stay "missing" and the aggregate shows up under `unrecognized`. The local
// `ipfs2foc report` (which has the membership in its DB) is the full
// reconciliation; the UI says so.

import { activePieceCids, dataSetProofHealth, maxBlockOfTxHashes, type ProofHealth } from 'ipfs2foc-core/pdp-verifier'
import type { NetworkKey } from './wallet.ts'

export interface VerifyInput {
  rpcUrl: string
  network: NetworkKey
  dataSetId: number
  /** PieceCID v2 strings this run prepared for the data set's provider. */
  preparedPieceCids: string[]
  /** AddPieces tx hashes the run recorded — bounds `provenSinceAdd` like the CLI report. */
  txHashes: string[]
}

export interface VerifyResult {
  /** Prepared pieces present in the data set's active pieces. */
  found: Set<string>
  /** Prepared pieces the chain does not have (under their own PieceCID). */
  missing: string[]
  /** Active on-chain pieces this run did not prepare — e.g. assembled pieces from the local path. */
  unrecognized: string[]
  health: ProofHealth
}

/** Injected so the logic is testable without a network; production uses the core reads. */
export interface VerifyDeps {
  activePieceCids: typeof activePieceCids
  dataSetProofHealth: typeof dataSetProofHealth
  maxBlockOfTxHashes: typeof maxBlockOfTxHashes
}

const defaultDeps: VerifyDeps = { activePieceCids, dataSetProofHealth, maxBlockOfTxHashes }

export async function verifyDataSet(input: VerifyInput, deps: VerifyDeps = defaultDeps): Promise<VerifyResult> {
  const { rpcUrl, network, dataSetId, preparedPieceCids, txHashes } = input
  const [active, maxAddEpoch] = await Promise.all([
    deps.activePieceCids(rpcUrl, network, dataSetId),
    deps.maxBlockOfTxHashes(rpcUrl, network, txHashes),
  ])
  const health = await deps.dataSetProofHealth(rpcUrl, network, dataSetId, maxAddEpoch)

  const prepared = new Set(preparedPieceCids)
  const found = new Set<string>()
  const missing: string[] = []
  for (const cid of prepared) {
    if (active.has(cid)) found.add(cid)
    else missing.push(cid)
  }
  const unrecognized = [...active].filter((cid) => !prepared.has(cid))
  return { found, missing, unrecognized, health }
}
