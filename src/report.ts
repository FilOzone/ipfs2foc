/**
 * Verification report: reconcile a run's local state against the data set's
 * on-chain pieces and emit explorer links.
 *
 * Each aggregate's root is recomputed from its members (the authoritative value
 * the provider re-derives on add) rather than read from the stored row, so a
 * report stays correct even if the plan that wrote the row predates a change to
 * the commitment. The recomputed root is matched against the data set's active
 * pieces to confirm the aggregate landed on chain.
 *
 * Optional `--verify-retrievable` mode probes each committed CID against the
 * provider's trustless gateway: success = HTTP 200 and content-type CAR. The
 * gateway URL is operator-supplied (typically the SP's public gateway, found
 * via PDP Scan).
 */

import { setTimeout as setTimer } from 'node:timers/promises'
import type { MigrationDB } from './db.ts'
import { resolveRpcUrl } from './gas.ts'
import { activePieceCids, explorerDataSetUrl, explorerPieceUrl } from './pdp-verifier.ts'
import { pieceAggregateCommP } from './piece-aggregate.ts'
import { CAR_ACCEPT, buildCarUrl } from './gateway.ts'
import { log } from './util.ts'

export interface ReportOptions {
  network: 'calibration' | 'mainnet'
  rpcUrl?: string
  dataSetId: number
  /** When set, GET each committed CID via this trustless-gateway base and confirm a 200 CAR. */
  verifyGateway?: string
  /** Bound on concurrent retrieval probes. Default 8. */
  verifyConcurrency?: number
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

export interface RetrievalCheck {
  ok: number
  failed: number
  /** First few failures with cid + error, for triage. */
  examples: Array<{ cid: string; error: string }>
}

export interface Report {
  dataSetId: number
  network: 'calibration' | 'mainnet'
  /**
   * Full input accounting: every CID `addCids` registered ends up in exactly
   * one bucket. `unaccounted` should always be 0; a non-zero value signals a
   * status the report does not yet understand and exits non-zero.
   */
  cids: {
    total: number
    committed: number
    pending: number
    failed: number
    oversized: number
    unaccounted: number
  }
  failuresByCategory: Record<string, number>
  aggregates: AggregateReport[]
  discrepancies: string[]
  retrieval?: RetrievalCheck
  /** True when committed + pending + failed + oversized + unaccounted == total and unaccounted == 0. */
  complete: boolean
}

export async function runReport(db: MigrationDB, opts: ReportOptions): Promise<Report> {
  const rpcUrl = resolveRpcUrl({ rpcUrl: opts.rpcUrl, network: opts.network })
  const onChainRoots = await activePieceCids(rpcUrl, opts.network, opts.dataSetId)
  const counts = db.counts()

  const aggregates: AggregateReport[] = []
  const discrepancies: string[] = []
  const committedCids: string[] = []

  for (const agg of db.aggregates()) {
    const members = db.aggregateManifest(agg.idx)
    const root = pieceAggregateCommP(members.map((m) => ({ pieceCid: m.pieceCid, rawSize: m.rawSize }))).rootPieceCid
    const onChain = onChainRoots.has(root)
    if (onChain) {
      // Asset CIDs (the original IPFS CIDs the operator listed), not the
      // PieceCIDv2 commitments — `--verify-retrievable` hits the provider's
      // trustless gateway as `/ipfs/{assetCid}?format=car`.
      for (const cid of db.aggregateAssetCids(agg.idx)) committedCids.push(cid)
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

  const committed = committedCids.length
  const pending = counts.pending + counts.processing + counts.done
  // `done` CIDs that are not yet in a committed aggregate count as pending
  // from the user's perspective. `committed` is the count of CIDs *in* an
  // on-chain aggregate. Subtract committed from pending to avoid double count.
  const pendingNotCommitted = Math.max(0, pending - committed)
  const unaccounted = Math.max(
    0,
    counts.total - committed - pendingNotCommitted - counts.failed - counts.oversized
  )

  const report: Report = {
    dataSetId: opts.dataSetId,
    network: opts.network,
    cids: {
      total: counts.total,
      committed,
      pending: pendingNotCommitted,
      failed: counts.failed,
      oversized: counts.oversized,
      unaccounted,
    },
    failuresByCategory: db.failuresByCategory(),
    aggregates,
    discrepancies,
    complete: unaccounted === 0 && pendingNotCommitted === 0 && counts.failed === 0,
  }

  // Optional retrieval probe: HEAD each committed CID against the provider's
  // trustless gateway. CAR content-type confirms the SP's IPFS indexing
  // exposed the contained CIDs.
  if (opts.verifyGateway != null && committedCids.length > 0) {
    report.retrieval = await verifyRetrievable(committedCids, opts.verifyGateway, opts.verifyConcurrency ?? 8)
  }

  log(`Data set ${opts.dataSetId} (${opts.network}) — ${explorerDataSetUrl(opts.network, opts.dataSetId)}`)
  log(
    `CIDs: ${report.cids.committed}/${report.cids.total} committed on chain, ` +
      `${report.cids.pending} pending, ${report.cids.failed} failed, ` +
      `${report.cids.oversized} oversized` +
      (unaccounted > 0 ? `, ${unaccounted} unaccounted` : '')
  )
  if (Object.keys(report.failuresByCategory).length > 0) {
    const summary = Object.entries(report.failuresByCategory)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
    log(`Failures by category: ${summary}`)
  }
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
  if (report.retrieval != null) {
    log(
      `Retrieval check (${opts.verifyGateway}): ` +
        `${report.retrieval.ok}/${report.retrieval.ok + report.retrieval.failed} CIDs returned 200 CAR`
    )
    for (const ex of report.retrieval.examples) {
      log(`  ! ${ex.cid}: ${ex.error}`)
    }
  }

  return report
}

/**
 * Probe each CID against `<gateway>/ipfs/{cid}?format=car&dag-scope=all` with
 * bounded concurrency. A 200 response with the CAR content-type counts as
 * retrievable; anything else (including non-CAR 200, redirects to non-CAR,
 * 4xx, 5xx, network error) counts as failed.
 */
async function verifyRetrievable(
  cids: string[],
  gateway: string,
  concurrency: number
): Promise<RetrievalCheck> {
  let ok = 0
  let failed = 0
  const examples: Array<{ cid: string; error: string }> = []
  let cursor = 0

  const probeOne = async (cid: string): Promise<void> => {
    const url = buildCarUrl(gateway, cid)
    try {
      const res = await fetch(url, { method: 'GET', headers: { accept: CAR_ACCEPT } })
      const contentType = res.headers.get('content-type') ?? ''
      if (!res.ok) {
        failed += 1
        if (examples.length < 5) examples.push({ cid, error: `HTTP ${res.status}` })
      } else if (!contentType.includes('application/vnd.ipld.car')) {
        failed += 1
        if (examples.length < 5) examples.push({ cid, error: `content-type ${contentType}` })
      } else {
        ok += 1
      }
      // Drain the body so the connection can be reused.
      await res.body?.cancel()
    } catch (err) {
      failed += 1
      const message = err instanceof Error ? err.message : String(err)
      if (examples.length < 5) examples.push({ cid, error: message })
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, cids.length) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= cids.length) return
      await probeOne(cids[i])
      // Tiny pacing delay so a single bad gateway is not hammered.
      if (i % 16 === 15) await setTimer(50)
    }
  })
  await Promise.all(workers)

  return { ok, failed, examples }
}
