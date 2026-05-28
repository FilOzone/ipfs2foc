/**
 * Verification report: reconcile a run's local state against the data set's
 * on-chain pieces and emit explorer links.
 *
 * Each aggregate's root is recomputed from its members (the authoritative value
 * the provider re-derives on add) rather than read from the stored row, so a
 * report stays correct even if the plan that wrote the row predates a change to
 * the commitment. The recomputed root is matched against the data set's active
 * pieces to confirm the aggregate landed on chain.
 */

import type { MigrationDB } from './db.ts'
import { resolveRpcUrl } from './gas.ts'
import { activePieceCids, explorerDataSetUrl, explorerPieceUrl } from './pdp-verifier.ts'
import { pieceAggregateCommP } from './piece-aggregate.ts'
import { log } from './util.ts'

export interface ReportOptions {
  network: 'calibration' | 'mainnet'
  rpcUrl?: string
  dataSetId: number
}

export interface AggregateReport {
  idx: number
  status: string
  members: number
  root: string
  txHash: string | null
  onChain: boolean
  dataSetUrl: string
  pieceUrl: string
}

export interface Report {
  dataSetId: number
  network: 'calibration' | 'mainnet'
  cids: { total: number; committed: number; pending: number; failed: number }
  aggregates: AggregateReport[]
  discrepancies: string[]
}

export async function runReport(db: MigrationDB, opts: ReportOptions): Promise<Report> {
  const rpcUrl = resolveRpcUrl({ rpcUrl: opts.rpcUrl, network: opts.network })
  const onChainRoots = await activePieceCids(rpcUrl, opts.network, opts.dataSetId)
  const counts = db.counts()

  const aggregates: AggregateReport[] = []
  const discrepancies: string[] = []
  let committedCids = 0

  for (const agg of db.aggregates()) {
    const members = db.aggregateManifest(agg.idx)
    const root = pieceAggregateCommP(members.map((m) => ({ pieceCid: m.pieceCid, rawSize: m.rawSize }))).rootPieceCid
    const onChain = onChainRoots.has(root)
    if (onChain) {
      committedCids += agg.memberCount
    }
    if (onChain && agg.status !== 'committed') {
      discrepancies.push(`aggregate ${agg.idx} is on chain but local status is '${agg.status}'`)
    }
    if (!onChain && agg.status === 'committed') {
      discrepancies.push(`aggregate ${agg.idx} is marked committed locally but is not on chain`)
    }
    aggregates.push({
      idx: agg.idx,
      status: agg.status,
      members: agg.memberCount,
      root,
      txHash: agg.txHash,
      onChain,
      dataSetUrl: explorerDataSetUrl(opts.network, opts.dataSetId),
      pieceUrl: explorerPieceUrl(opts.network, root),
    })
  }

  const totalCids = counts.pending + counts.processing + counts.done + counts.failed
  const report: Report = {
    dataSetId: opts.dataSetId,
    network: opts.network,
    cids: { total: totalCids, committed: committedCids, pending: counts.pending + counts.processing, failed: counts.failed },
    aggregates,
    discrepancies,
  }

  log(`Data set ${opts.dataSetId} (${opts.network}) — ${explorerDataSetUrl(opts.network, opts.dataSetId)}`)
  log(`CIDs: ${committedCids}/${totalCids} committed on chain, ${report.cids.pending} pending, ${report.cids.failed} failed`)
  for (const a of aggregates) {
    log(
      `  aggregate ${a.idx} [${a.onChain ? 'on-chain' : a.status}] ${a.members} CID(s) ${a.root}` +
        `\n    piece:   ${a.pieceUrl}` +
        (a.txHash != null ? `\n    tx:      ${a.txHash}` : '')
    )
  }
  if (discrepancies.length > 0) {
    log('Discrepancies:')
    for (const d of discrepancies) {
      log(`  ${d}`)
    }
  }

  return report
}
