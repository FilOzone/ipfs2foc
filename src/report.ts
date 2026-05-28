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
  /** When set, HEAD-probe committed CIDs via this trustless-gateway base. */
  verifyGateway?: string
  /**
   * Cap on CIDs probed under `--verify-gateway`. Defaults to 100 (a spot
   * check). Pass `Infinity` (CLI `--verify-all`) for an exhaustive sweep.
   * At million-CID scale a full sweep is millions of HEAD requests, so the
   * default samples and lets the operator opt into exhaustive checks.
   */
  verifySample?: number
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
  /** How many CIDs were probed (may be less than the committed total if sampled). */
  probed: number
  /** Total committed CIDs the sample was drawn from. */
  population: number
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
  /**
   * Aggregates whose root is active on chain. Recorded as `(idx, memberCount)`
   * tuples only — asset CIDs themselves are not materialized here, since for
   * million-CID jobs the flat list would be hundreds of MB held only to
   * sample 100 of them. `--verify-gateway` walks these tuples on demand in a
   * second pass.
   */
  const committedAggs: Array<{ idx: number; memberCount: number }> = []
  let committed = 0

  for (const agg of db.aggregates()) {
    const members = db.aggregateManifest(agg.idx)
    const root = pieceAggregateCommP(members.map((m) => ({ pieceCid: m.pieceCid, rawSize: m.rawSize }))).rootPieceCid
    const onChain = onChainRoots.has(root)
    if (onChain) {
      committed += agg.memberCount
      committedAggs.push({ idx: agg.idx, memberCount: agg.memberCount })
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

  // Optional retrieval probe: HEAD each sampled committed CID against the
  // provider's trustless gateway. CAR content-type confirms the SP's IPFS
  // indexing exposed the contained CIDs. Sampling materializes only the
  // chosen CIDs, never the full committed list.
  if (opts.verifyGateway != null && committed > 0) {
    const sampleSize = opts.verifySample ?? 100
    const sample = collectSample(db, committedAggs, committed, sampleSize)
    report.retrieval = await verifyRetrievable(
      sample,
      committed,
      opts.verifyGateway,
      opts.verifyConcurrency ?? 8
    )
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
    const r = report.retrieval
    const scope = r.probed === r.population ? `all ${r.population}` : `sample ${r.probed}/${r.population}`
    log(`Retrieval check (${opts.verifyGateway}, ${scope}): ${r.ok} ok, ${r.failed} failed`)
    for (const ex of r.examples) {
      log(`  ! ${ex.cid}: ${ex.error}`)
    }
  }

  return report
}

/**
 * HEAD-probe each CID against `<gateway>/ipfs/{cid}?format=car&dag-scope=all`
 * with bounded concurrency. A 200 with the CAR content-type counts as
 * retrievable; anything else (non-CAR 200, 4xx, 5xx, network error) counts
 * as failed. HEAD avoids transferring CAR bodies — a single HEAD per CID is
 * cheap enough that the sample size is the real bound.
 */
async function verifyRetrievable(
  cids: string[],
  population: number,
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
      const res = await fetch(url, { method: 'HEAD', headers: { accept: CAR_ACCEPT } })
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
    }
  })
  await Promise.all(workers)

  return { probed: cids.length, population, ok, failed, examples }
}

/**
 * Materialize a deterministic stride sample of size `n` from the asset CIDs
 * of every committed aggregate, without ever holding the full list in
 * memory. Walk each aggregate only when its absolute index range intersects
 * a target sample index; load that aggregate's asset CIDs, extract the
 * hits, and drop the array.
 *
 * Stride sampling (rather than reservoir) keeps the choice reproducible
 * across `report` runs against the same DB — a re-run hits the same CIDs.
 *
 * Memory: O(n) for the output + O(memberCount) for the current aggregate's
 * temp array. For a 32 GiB aggregate of 512 KiB assets that's ~65k strings
 * (~4 MB) per aggregate, then released.
 */
function collectSample(
  db: MigrationDB,
  committedAggs: Array<{ idx: number; memberCount: number }>,
  population: number,
  n: number
): string[] {
  const sampleCount = !Number.isFinite(n) || n >= population ? population : Math.max(0, Math.floor(n))
  if (sampleCount === 0) return []

  // Compute target absolute indices into the virtual concat of all committed
  // aggregate-member lists. Sorted ascending so a single forward walk hits them.
  const targets: number[] = new Array(sampleCount)
  const step = population / sampleCount
  for (let i = 0; i < sampleCount; i++) targets[i] = Math.floor(i * step)

  const out: string[] = []
  let absolute = 0
  let nextTarget = 0
  for (const agg of committedAggs) {
    if (nextTarget >= targets.length) break
    const end = absolute + agg.memberCount
    if (targets[nextTarget] < end) {
      const cids = db.aggregateAssetCids(agg.idx)
      while (nextTarget < targets.length && targets[nextTarget] < end) {
        out.push(cids[targets[nextTarget] - absolute])
        nextTarget++
      }
    }
    absolute = end
  }
  return out
}
