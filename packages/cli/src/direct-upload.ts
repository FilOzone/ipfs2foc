/**
 * Direct upload: stream locally packed CARs straight to storage providers and
 * batch the on-chain adds (issue #70). This replaces provider-pull ingress for
 * users with no public origin: nothing here requires inbound connectivity.
 *
 * Per built sub-piece CAR:
 *   1. store() the bytes on the primary provider — the piece is now "parked"
 *      and Curio's GC clock starts.
 *   2. Each secondary pulls the piece from the primary's retrieval URL
 *      (provider-to-provider; the client uploads once).
 *   3. Parked pieces accumulate per provider and are flushed through one
 *      commit() (addPieces) when the batch fills, the GC-window guess nears
 *      expiry, or the source drains — see gc-window.ts for the scheduling
 *      rules and why every tie breaks toward flushing early.
 *
 * Gas is the provider's cost (the provider submits addPieces with the
 * client's EIP-712 authorisation), so unlike pdp-submit this loop has no
 * base-fee gate: pausing would save the provider gas while running the
 * client's parked pieces into GC.
 */

import { createReadStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { findPiece } from '@filoz/synapse-core/sp'
import { calibration, mainnet, Synapse } from '@filoz/synapse-sdk'
import { CID } from 'multiformats/cid'
import { type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { MigrationDB } from './db.ts'
import { resolveRpcUrl } from './gas.ts'
import {
  collectedCidFromError,
  DEFAULT_ASSUMED_WINDOW_MS,
  lowerWindowOnGc,
  MAX_ADD_PIECES_BATCH,
  marginFromConfirmations,
  shouldFlush,
} from './gc-window.ts'
import { formatBytes, formatDuration, Timer } from './metrics.ts'
import { log } from './util.ts'

export interface DirectUploadOptions {
  network: 'calibration' | 'mainnet'
  rpcUrl?: string
  privateKey?: Hex
  /** Number of provider copies (contexts). Default 2: primary + one secondary. */
  copies?: number
  /** Pin specific providers instead of SDK selection. */
  providerIds?: bigint[]
  /** Reuse existing data sets instead of creating new ones. */
  dataSetIds?: bigint[]
  /** Starting GC-window guess; persisted per-provider lowering still applies. */
  assumedWindowMs?: number
  /** Data-set metadata. Defaults to requesting IPFS indexing/IPNI announce. */
  dataSetMetadata?: Record<string, string>
}

/** The storage-context surface the loop drives; narrowed for fakes in tests. */
export interface UploadContextLike {
  providerId: string
  serviceURL: string
  dataSetId: string | null
  store(
    data: ReadableStream | Uint8Array,
    options: { pieceCid?: unknown; onProgress?: (bytes: number) => void }
  ): Promise<{ pieceCid: unknown; size: number }>
  /** EIP-712 authorization for pulls/commits of these pieces on this provider. */
  presignForCommit(pieces: Array<{ pieceCid: unknown }>): Promise<unknown>
  pull(options: {
    pieces: unknown[]
    /**
     * Pull source. MUST be the per-piece URL function form: the SDK treats a
     * string as a service-URL base and appends its own path, which mangles an
     * already-complete piece URL into a source the provider cannot fetch.
     */
    from: (pieceCid: unknown) => string
    extraData?: unknown
  }): Promise<{
    status: 'complete' | 'failed'
    pieces: Array<{ pieceCid: unknown; status: 'complete' | 'failed' }>
  }>
  commit(options: { pieces: Array<{ pieceCid: unknown }>; onSubmitted?: (txHash: string) => void }): Promise<{
    txHash: string
    pieceIds: bigint[]
    dataSetId: bigint
  }>
  getPieceUrl(pieceCid: unknown): string
  /** Probe whether a parked piece is still present (post-GC re-verify). */
  hasPiece(pieceCid: unknown): Promise<boolean>
}

export interface DirectUploadDeps {
  setup(opts: DirectUploadOptions, rpcUrl: string): Promise<{ contexts: UploadContextLike[] }>
  /** Injectable clock so tests can drive the window timer. */
  now(): number
  /** Open a built CAR for streaming. Injectable so tests skip the filesystem. */
  openCar(path: string): ReadableStream | Uint8Array
  evictCar(path: string): Promise<void>
}

export const defaultDirectUploadDeps: DirectUploadDeps = {
  async setup(opts, rpcUrl) {
    if (opts.privateKey == null) {
      throw new Error('direct upload requires PRIVATE_KEY')
    }
    const chain = opts.network === 'mainnet' ? mainnet : calibration
    const account = privateKeyToAccount(opts.privateKey)
    const synapse = await Synapse.create({ account, transport: http(rpcUrl), chain, source: null })
    const contexts = await synapse.storage.createContexts({
      copies: opts.copies ?? 2,
      ...(opts.providerIds == null ? {} : { providerIds: opts.providerIds }),
      ...(opts.dataSetIds == null ? {} : { dataSetIds: opts.dataSetIds }),
      metadata: opts.dataSetMetadata ?? { withIPFSIndexing: '' },
    })
    if (contexts.length === 0) throw new Error('no storage contexts resolved')
    return {
      contexts: contexts.map((ctx): UploadContextLike => {
        const serviceURL = ctx.provider.pdp.serviceURL
        return {
          providerId: String(ctx.provider.id),
          serviceURL,
          dataSetId: ctx.dataSetId == null ? null : String(ctx.dataSetId),
          store: (data, options) => ctx.store(data as never, options as never),
          presignForCommit: (pieces) => ctx.presignForCommit(pieces as never),
          pull: (options) => ctx.pull(options as never),
          commit: (options) => ctx.commit(options as never),
          getPieceUrl: (pieceCid) => ctx.getPieceUrl(pieceCid as never),
          hasPiece: async (pieceCid) => {
            try {
              await findPiece({ serviceURL, pieceCid: pieceCid as never, retry: false })
              return true
            } catch {
              return false
            }
          },
        }
      }),
    }
  },
  now: () => Date.now(),
  openCar: (path) => Readable.toWeb(createReadStream(path)) as ReadableStream,
  evictCar: async (path) => {
    try {
      await unlink(path)
    } catch (err) {
      log(`warn: failed to evict cached CAR ${path}: ${(err as Error).message}`)
    }
  },
}

export interface DirectUploadSummary {
  network: string
  providers: Array<{
    providerId: string
    role: 'primary' | 'secondary'
    dataSetId: string | null
    committed: number
    collected: number
    failed: number
    flushes: number
    assumedWindowMs: number
  }>
  storedBytes: number
  evictedCars: number
}

export async function runDirectUpload(
  db: MigrationDB,
  opts: DirectUploadOptions,
  deps: DirectUploadDeps = defaultDirectUploadDeps
): Promise<DirectUploadSummary> {
  const rpcUrl = resolveRpcUrl({ rpcUrl: opts.rpcUrl, network: opts.network })
  const { contexts } = await deps.setup(opts, rpcUrl)
  const [primary, ...secondaries] = contexts
  if (primary == null) throw new Error('no primary storage context')

  log(
    `direct upload to ${contexts.length} provider(s): ` +
      contexts.map((c, i) => `${i === 0 ? 'primary' : 'secondary'} ${c.providerId} (${c.serviceURL})`).join(', ')
  )

  const observedCommitMs: number[] = []
  const flushCounts = new Map<string, number>()
  const runTimer = new Timer()
  let storedBytes = 0

  const windowFor = (ctx: UploadContextLike): number =>
    db.providerWindowMs(ctx.providerId, opts.assumedWindowMs ?? DEFAULT_ASSUMED_WINDOW_MS)

  const flush = async (ctx: UploadContextLike, reason: string): Promise<void> => {
    const batch = db.parkedUploads(ctx.providerId).slice(0, MAX_ADD_PIECES_BATCH)
    if (batch.length === 0) return
    flushCounts.set(ctx.providerId, (flushCounts.get(ctx.providerId) ?? 0) + 1)
    const cids = batch.map((b) => b.subPieceCid)
    log(`flush [${reason}] provider ${ctx.providerId}: committing ${batch.length} piece(s)`)
    // Durable breadcrumb before the attempt — a crash mid-commit must never be
    // auto-resolved into a blind re-add (same invariant as pdp-submit).
    db.markUploadsAddUnconfirmed(cids, ctx.providerId)
    const commitTimer = new Timer()
    try {
      const result = await ctx.commit({
        pieces: cids.map((cid) => ({ pieceCid: CID.parse(cid) })),
        onSubmitted: (txHash) => db.markUploadTxSubmitted(cids, ctx.providerId, txHash),
      })
      observedCommitMs.push(commitTimer.stop())
      batch.forEach((b, i) => {
        db.markUploadCommitted(b.subPieceCid, ctx.providerId, {
          dataSetId: String(result.dataSetId),
          pieceId: String(result.pieceIds[i] ?? ''),
          txHash: result.txHash,
        })
      })
      log(`committed ${batch.length} piece(s) on provider ${ctx.providerId} (data set ${result.dataSetId})`)
    } catch (err) {
      const message = (err as Error).message ?? String(err)
      const gcCid = collectedCidFromError(message)
      if (gcCid == null) {
        // Not a GC rejection: leave the batch in add_unconfirmed for the
        // resume reconciliation — a blind retry could double-add on chain.
        log(`error: commit failed on provider ${ctx.providerId} (batch left add_unconfirmed): ${message}`)
        return
      }
      // Curio rejected the batch because a parked piece is gone. The batch is
      // atomic and pre-chain, so nothing landed. Lower the window from the
      // collected piece's parked age, then re-verify every batch member —
      // Curio reports only the FIRST miss.
      const collected = batch.find((b) => b.subPieceCid === gcCid)
      if (collected == null) {
        log(`warn: provider ${ctx.providerId} rejected unknown sub-piece ${gcCid}; re-verifying batch`)
      } else {
        const age = deps.now() - Date.parse(collected.parkedAt)
        const lowered = lowerWindowOnGc(windowFor(ctx), age)
        db.lowerProviderWindow(ctx.providerId, lowered)
        log(
          `GC detected on provider ${ctx.providerId}: ${gcCid} collected after ${formatDuration(age)} parked; ` +
            `window lowered to ${formatDuration(lowered)}`
        )
      }
      for (const b of batch) {
        const present = b.subPieceCid !== gcCid && (await ctx.hasPiece(CID.parse(b.subPieceCid)))
        if (present) {
          db.revertUploadsToParked([b.subPieceCid], ctx.providerId)
        } else {
          db.markUploadCollected(b.subPieceCid, ctx.providerId)
          log(`collected: ${b.subPieceCid} on provider ${ctx.providerId} (will re-store)`)
        }
      }
    }
  }

  // Evict staged CARs whose every copy is committed. Runs after every flush,
  // not just at run end: the disk high-water mark must track the uncommitted
  // window, not the whole migration.
  let evicted = 0
  const evictCommitted = async (): Promise<void> => {
    for (const path of db.carPathsFullyCommitted()) {
      await deps.evictCar(path)
      evicted++
    }
  }

  const maybeFlush = async (drained: boolean): Promise<void> => {
    for (const ctx of contexts) {
      // Loop: a full batch may leave more parked pieces behind it.
      for (;;) {
        const parked = db.parkedUploads(ctx.providerId)
        const reason = shouldFlush({
          batchSize: parked.length,
          oldestParkedAtMs: parked.length === 0 ? null : Date.parse(parked[0].parkedAt),
          nowMs: deps.now(),
          assumedWindowMs: windowFor(ctx),
          marginMs: marginFromConfirmations(observedCommitMs),
          drained,
        })
        if (reason == null) break
        await flush(ctx, reason)
        if (db.parkedUploads(ctx.providerId).length === parked.length) break // no progress; avoid spinning
      }
    }
    await evictCommitted()
  }

  // Reconcile add_unconfirmed leftovers from a previous run before uploading
  // anything new: their outcome is unknown and a blind re-add would duplicate.
  for (const ctx of contexts) {
    await reconcileUnconfirmed(db, ctx)
  }

  // Main loop: store on the primary, fan out to secondaries, flush as batches
  // and window timers demand. Sequential per piece — the upstream bandwidth is
  // the bottleneck, and one in-flight store keeps the disk footprint bounded.
  for (;;) {
    const pending = db.subPiecesNeedingUpload(primary.providerId)
    const next = pending[0]
    if (next == null) break
    if (next.carPath == null) {
      // subPiecesNeedingUpload selects car_path IS NOT NULL; reaching this is a query bug.
      throw new Error(`sub-piece ${next.subPieceCid} has no local CAR path`)
    }

    const storeTimer = new Timer()
    const stored = await storeCar(primary, deps, next.carPath, next.subPieceCid)
    storedBytes += stored.size
    db.recordUploadParked(next.subPieceCid, primary.providerId, 'primary', primary.dataSetId)
    log(
      `parked ${next.subPieceCid} (${formatBytes(stored.size)}) on primary ${primary.providerId} ` +
        `in ${formatDuration(storeTimer.stop())}`
    )

    for (const secondary of secondaries) {
      await pullToSecondary(db, primary, secondary, next.subPieceCid)
    }

    await maybeFlush(false)
  }

  // Source drained: flush whatever is parked, then retry what didn't land —
  // collected pieces (GC'd before commit) and failed secondary pulls. A
  // primary copy re-uploads from the staged CAR; a secondary copy re-pulls
  // from the primary, which still holds the bytes.
  await maybeFlush(true)
  for (let attempt = 0; attempt < 3; attempt++) {
    const needsRetry = contexts.flatMap((ctx, i) =>
      ['collected' as const, ...(i > 0 ? ['failed' as const] : [])]
        .flatMap((status) => db.uploadsByStatus(ctx.providerId, status))
        .map((u) => ({ ctx, u }))
    )
    if (needsRetry.length === 0) break
    log(`retrying ${needsRetry.length} piece(s) that did not land (attempt ${attempt + 1})`)
    for (const { ctx, u } of needsRetry) {
      if (u.role === 'secondary') {
        await pullToSecondary(db, primary, ctx, u.subPieceCid)
        continue
      }
      const sub = db.subPieceByCid(u.subPieceCid)
      if (sub?.carPath == null) {
        log(`error: collected ${u.subPieceCid} has no local CAR; cannot re-store`)
        continue
      }
      const stored = await storeCar(ctx, deps, sub.carPath, sub.subPieceCid)
      storedBytes += stored.size
      db.recordUploadParked(sub.subPieceCid, ctx.providerId, u.role, ctx.dataSetId)
    }
    await maybeFlush(true)
  }

  await evictCommitted()

  const summary: DirectUploadSummary = {
    network: opts.network,
    providers: contexts.map((ctx, i) => ({
      providerId: ctx.providerId,
      role: i === 0 ? 'primary' : 'secondary',
      dataSetId: latestDataSetId(db, ctx),
      committed: db.uploadsByStatus(ctx.providerId, 'committed').length,
      collected: db.uploadsByStatus(ctx.providerId, 'collected').length,
      failed: db.uploadsByStatus(ctx.providerId, 'failed').length,
      flushes: flushCounts.get(ctx.providerId) ?? 0,
      assumedWindowMs: windowFor(ctx),
    })),
    storedBytes,
    evictedCars: evicted,
  }
  log(`direct upload finished in ${formatDuration(runTimer.stop())}: ${formatBytes(storedBytes)} stored`)
  return summary
}

async function storeCar(
  ctx: UploadContextLike,
  deps: DirectUploadDeps,
  carPath: string,
  subPieceCid: string
): Promise<{ size: number }> {
  const result = await ctx.store(deps.openCar(carPath), { pieceCid: CID.parse(subPieceCid) })
  return { size: result.size }
}

/** Resolve every add_unconfirmed row by probing the provider for the bytes. */
async function reconcileUnconfirmed(db: MigrationDB, ctx: UploadContextLike): Promise<void> {
  for (const u of db.uploadsByStatus(ctx.providerId, 'add_unconfirmed')) {
    if (await ctx.hasPiece(CID.parse(u.subPieceCid))) {
      db.revertUploadsToParked([u.subPieceCid], ctx.providerId)
      log(`resume: ${u.subPieceCid} still parked on provider ${ctx.providerId}; re-queued for commit`)
    } else {
      db.markUploadCollected(u.subPieceCid, ctx.providerId)
      log(`resume: ${u.subPieceCid} gone from provider ${ctx.providerId}; will re-store`)
    }
  }
}

/** Have one secondary pull a freshly parked piece from the primary. */
async function pullToSecondary(
  db: MigrationDB,
  primary: UploadContextLike,
  secondary: UploadContextLike,
  subPieceCid: string
): Promise<void> {
  try {
    // Curio authenticates the pull with the same EIP-712 authorization used
    // for commit — a pull without it is rejected.
    const extraData = await secondary.presignForCommit([{ pieceCid: CID.parse(subPieceCid) }])
    const pulled = await secondary.pull({
      pieces: [CID.parse(subPieceCid)],
      from: (pieceCid) => primary.getPieceUrl(pieceCid),
      extraData,
    })
    if (pulled.status === 'complete') {
      db.recordUploadParked(subPieceCid, secondary.providerId, 'secondary', secondary.dataSetId)
      log(`parked ${subPieceCid} on secondary ${secondary.providerId} (pulled from primary)`)
    } else {
      db.markUploadFailed(subPieceCid, secondary.providerId, 'secondary', 'secondary pull failed')
      log(`warn: secondary ${secondary.providerId} failed to pull ${subPieceCid}`)
    }
  } catch (err) {
    db.markUploadFailed(subPieceCid, secondary.providerId, 'secondary', (err as Error).message)
    log(`warn: secondary ${secondary.providerId} pull error for ${subPieceCid}: ${(err as Error).message}`)
  }
}

function latestDataSetId(db: MigrationDB, ctx: UploadContextLike): string | null {
  const committed = db.uploadsByStatus(ctx.providerId, 'committed')
  return committed.length > 0 ? committed[committed.length - 1].dataSetId : ctx.dataSetId
}
