import { toCanonicalCidV1 } from 'ipfs2foc-core'
import type { Capabilities } from 'ipfs2foc-core/capabilities'
import { explorerDataSetUrl, explorerPieceUrl } from 'ipfs2foc-core/pdp-verifier'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { trackOnce } from './analytics.ts'
import { DEFAULT_RELAY } from './capabilities.ts'
import { type CidIntake, parseCidFile } from './cid-file.ts'
import { dedupeCanonical, invalidCidStrings } from './cid-union.ts'
import { computePiece, describePrepareFailure, type PreparePhase, stallMessage } from './commp.ts'
import { Continuity, Led } from './components/continuity.tsx'
import { fmtBytes, fmtEta, fmtExpiry, short } from './components/format.ts'
import { HistoryChrome } from './components/history-chrome.tsx'
import { Lede } from './components/lede.tsx'
import {
  ByteCapNotice,
  CidCapNotice,
  ContactLink,
  FailureSummary,
  InvalidCidNote,
  LongRunAdvisory,
} from './components/notices.tsx'
import { PieceRow } from './components/piece-row.tsx'
import { SessionExpiryNote, SessionGrantExplainer } from './components/session-notes.tsx'
import { deriveStage, estimateCostUsdfc, historyEntries, type Stage } from './flow.ts'
import { FocMark } from './foc-mark.tsx'
import { deriveFundingState, fundingChecklist } from './funding.ts'
import { HASH_POOL_SIZE } from './hash-pool.ts'
import { buildManifest, downloadManifest } from './manifest.ts'
import {
  fmtToken,
  type PaymentsStatus,
  RPC_URLS,
  readPaymentsStatus,
  readStorageRate,
  readyToSign,
} from './payments.ts'
import { createPrepareStore, type RowFilter } from './prepare-store.ts'
import { discoverRootSources, type RootSources } from './provider-discovery.ts'
import { chunkEtaSeconds, latchLongRun, overByteCap, overCidCap, runLimits } from './run-limits.ts'
import { clearRun, clearSubmit, loadRun, loadSubmit, type SavedSubmit, saveRun, saveSubmit } from './run-store.ts'
import {
  DEFAULT_SESSION_DURATION_SECONDS,
  extendSession,
  grantSession,
  resumeSession,
  revokeSession,
  SESSION_DURATIONS,
  type SessionState,
  sessionCanPresign,
} from './session.ts'
import {
  findResumableSubmit,
  partitionSubmittable,
  requeueDeferred,
  runSubmit,
  SubmitBlockedError,
  type SubmitContextStatus,
  type SubmitState,
  submitStateFromSaved,
} from './submit.ts'
import { useTabLifetime } from './tab-guard.ts'
import { reportFundingState, reportFunnelState, reportSigningDeclined } from './telemetry.ts'
import { type VerifyResult, verifyDataSet } from './verify.ts'
import {
  connectWallet,
  injectedProvider,
  NETWORKS,
  type NetworkKey,
  networkOf,
  onWalletChange,
  refreshWallet,
  switchToNetwork,
  type WalletState,
} from './wallet.ts'

const DEFAULT_GATEWAY = 'https://trustless-gateway.link'

// Process several CIDs at once. Retrieval (one streaming CAR request per
// root) and CAR assembly run on this thread; the CPU-bound hashing runs in
// HASH_POOL_SIZE pooled workers. Retrieval is network-bound and mostly idle
// waiting on the gateway, so many more fetches stay in flight than there are
// hashing cores — a piece claims a worker only when its bytes are ready to
// hash (#59). Measured against the default gateway on a real inventory
// (63 KiB median root): 4 in flight ≈ 2 pieces/s, 16 ≈ 10/s, 32 ≈ 18/s, with
// no added failures — the gateway round-trip, not bandwidth or CPU, is what
// this hides.
// `?concurrency=64` overrides the pool width for this tab, the lever for
// measuring where throughput stops scaling with in-flight count. Each
// in-flight piece can buffer up to HASH_HANDOFF_BYTES (4 MiB) before it
// claims a hash worker, so pool width bounds transient memory: the clamp at
// 128 keeps even a mistyped value to ~512 MiB of buffers instead of letting
// it grow without limit. The gateways and routing endpoint measured against
// all speak HTTP/2, so the browser multiplexes these over one connection
// per host; the six-connection ceiling only applies to HTTP/1.1 origins.
const CONCURRENCY = (() => {
  const dflt = 8 * HASH_POOL_SIZE
  const raw = Number(new URLSearchParams(window.location.search).get('concurrency'))
  if (!Number.isInteger(raw) || raw < 1) return dflt
  return Math.min(raw, 128)
})()
// Don't re-render on every stream chunk — that starves the thread doing the
// hashing. Emit progress at most this often.
const PROGRESS_THROTTLE_MS = 250
// A working row that has not advanced its byte counter for this long is
// stalled and gets aborted with a retryable error (#43). A healthy stream
// ticks continuously; even a cold gateway warming a block through retries
// produces a byte well inside this window. The CLI's provider-pull watchdog
// (PULL_STALL_TIMEOUT_MS, 15 min) guards whole-piece pulls; this guards a
// per-chunk stream, so it can be much tighter.
const STALL_TIMEOUT_MS = 120_000
// A piece waiting for a hash worker is backpressure, not a stall: its byte
// counter is frozen by design (the download already finished), and the wait
// is bounded by how long the pieces holding workers keep streaming. Give the
// claim its own budget so a busy pool queues rows instead of failing them;
// only a pool that stays saturated this long is actually wedged.
const CLAIM_STALL_TIMEOUT_MS = 600_000
const STALL_POLL_MS = 5_000
// Well inside the abort budgets: the row admits it has gone quiet long
// before the watchdog gives up, so a slow source reads as patience, not a
// frozen tab.
const STALL_HINT_MS = 30_000
// The pieces table shows one page at a time (#57): a million-CID run must
// never put a million rows in the DOM. One page fits on a screen or two, and
// the state filters get the operator to the rows that matter. The Working
// view pages smaller still — it is a glance at live progress, not a list to
// read, and the full worker pool would fill the screen.
const PAGE_SIZE = 50
const WORKING_PAGE_SIZE = 8
// The ETA averages completions over this trailing window: long enough to
// smooth the small-piece bursts, short enough to follow a slowing source.
const ETA_WINDOW_MS = 90_000
// Persisting the run snapshots the whole input list and every result into
// IndexedDB. Per-completion saves were fine at hundreds of CIDs; at millions
// each save clones the full list, so completions coalesce into one save per
// interval (the run's end still saves immediately).
const PERSIST_INTERVAL_MS = 5_000

const ROW_FILTERS: Array<{ key: RowFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'queued', label: 'Queued' },
  { key: 'working', label: 'Working' },
  { key: 'done', label: 'Ready' },
  { key: 'error', label: 'Failed' },
]

function describeSubmitPhase(c: SubmitContextStatus): string {
  // Large runs land in several chunks (one provider add each); show which
  // one is in flight so a long submit reads as progress, not repetition.
  const chunk = c.chunkIndex != null && c.chunks.length > 1 ? `chunk ${c.chunkIndex + 1}/${c.chunks.length} · ` : ''
  switch (c.phase) {
    case 'queued':
      return 'queued'
    case 'presigning':
      return `${chunk}signing authorization…`
    case 'pulling': {
      const statuses = c.pullStatus ? Object.values(c.pullStatus) : []
      const done = statuses.filter((s) => s === 'complete').length
      return `${chunk}provider pulling ${done}/${statuses.length}…`
    }
    case 'committing':
      return `${chunk}committing on-chain…`
    case 'confirming':
      return `${chunk}confirming…`
    case 'done':
      return 'committed ✓'
    case 'failed':
      return c.error ?? 'failed'
  }
}

export default function App({ caps }: { caps: Capabilities }) {
  const [wallet, setWallet] = useState<WalletState | null>(null)
  const [walletError, setWalletError] = useState<string | null>(null)
  // The network this run targets. A `serve` daemon pins its own; the hosted
  // console starts on capabilities.DEFAULT_NETWORK and lets the operator switch,
  // so a run can be rehearsed on calibration before it spends real USDFC.
  const [targetNetwork, setTargetNetwork] = useState<NetworkKey>(caps.network)
  const [payments, setPayments] = useState<PaymentsStatus | null>(null)
  const [paymentsError, setPaymentsError] = useState<string | null>(null)
  const [paymentsLoading, setPaymentsLoading] = useState(false)
  const [session, setSession] = useState<SessionState | null>(null)
  const [sessionBusy, setSessionBusy] = useState<string | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [sessionDuration, setSessionDuration] = useState<bigint>(DEFAULT_SESSION_DURATION_SECONDS)
  const [cidsText, setCidsText] = useState('')
  // CIDs loaded from a cids.txt file (#50). Kept out of the textarea: an
  // inventory file can run to tens of thousands of lines, more than a
  // textarea (or a person) should hold. Joined with the pasted list in
  // `cids` below.
  const [cidFile, setCidFile] = useState<{ name: string; intake: CidIntake } | null>(null)
  const [cidFileBusy, setCidFileBusy] = useState(false)
  const [cidFileError, setCidFileError] = useState<string | null>(null)
  const [relayBase, setRelayBase] = useState(caps.pieceBase ?? DEFAULT_RELAY)
  const [gateway, setGateway] = useState(DEFAULT_GATEWAY)
  // Row state lives in the store, not in a useState array: the input list can
  // run to millions and per-row state churn must not re-render (or rebuild)
  // the world (#57). The version subscription re-renders this component at
  // most every NOTIFY_MS; everything read from the store is cached inside it.
  const [store] = useState(createPrepareStore)
  useSyncExternalStore(store.subscribe, store.getVersion)
  const [rowFilter, setRowFilter] = useState<RowFilter>('all')
  const [rowPage, setRowPage] = useState(0)
  const [running, setRunning] = useState(false)
  // Prepared bytes crossed the hosted run ceiling mid-run: the pool stopped
  // admitting new roots and the rest of the list stayed queued.
  const [byteCapHit, setByteCapHit] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  // Failed row whose full error chain is expanded inline. The headline is
  // deliberately short; the chain is where the phase-specific stall message
  // and the underlying cause live.
  const [errOpen, setErrOpen] = useState<string | null>(null)
  const [copies, setCopies] = useState(2)
  const [months, setMonths] = useState(1)
  const [submitState, setSubmitState] = useState<SubmitState | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitBlocked, setSubmitBlocked] = useState<SubmitBlockedError['reason'] | null>(null)
  const [resumable, setResumable] = useState<SavedSubmit | null>(null)
  const [restored, setRestored] = useState(false)
  // The one-active-step flow: the operator's two consent clicks, and which
  // completed step (if any) the history chrome is peeking at.
  const [reviewedPrepare, setReviewedPrepare] = useState(false)
  const [costAccepted, setCostAccepted] = useState(false)
  const [peek, setPeek] = useState<Stage | null>(null)
  // The storage rate the cost gate estimates against; read lazily on entry.
  const [rate, setRate] = useState<import('./flow.ts').StorageRate | null>(null)
  const [rateError, setRateError] = useState<string | null>(null)
  // Writes are blocked until the restore attempt settles, so an early debounced
  // persist of the empty textarea cannot clobber a saved run.
  const hydrated = useRef(false)
  // True once any prepare run has started this page-load. The async restore
  // below races a run started before it resolves: resetting the store to the
  // saved (older) snapshot re-marked finished rows as queued and made the
  // pool look like it died mid-run (#42).
  const ranRef = useRef(false)

  // Restore the previous run once on load (#26). Done rows come back as done;
  // anything else shows queued and recomputes on the next prepare.
  useEffect(() => {
    loadRun().then((saved) => {
      hydrated.current = true
      if (saved == null) return
      // Merge, never replace: a run that started before this restore resolved
      // has fresher results than the snapshot read from storage (#42).
      for (const [cid, result] of Object.entries(saved.results)) {
        store.seedResult(cid, result)
      }
      // A live (or finished) run owns the input and the rows — restoring the
      // saved snapshot over them would clobber its progress (#42).
      if (ranRef.current) return
      setCidsText(saved.cidsText)
      setRelayBase(saved.relayBase)
      setGateway(saved.gateway)
      if (saved.fileCids != null && saved.fileCids.length > 0) {
        setCidFile({
          name: saved.fileName ?? 'cids.txt',
          intake: { cids: saved.fileCids, invalidSamples: [], invalidCount: saved.fileInvalidCount ?? 0 },
        })
      }
      const savedCids = Array.from(
        new Set(
          saved.cidsText
            .split(/\s+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .concat(saved.fileCids ?? [])
        )
      )
      if (savedCids.some((cid) => store.hasResult(cid))) {
        store.setCids(savedCids)
        setRestored(true)
      }
    })
  }, [store])

  const persist = useCallback(
    (text: string) => {
      if (!hydrated.current) return
      void saveRun({
        cidsText: text,
        fileName: cidFile?.name,
        fileCids: cidFile?.intake.cids,
        fileInvalidCount: cidFile?.intake.invalidCount,
        gateway,
        relayBase,
        results: store.resultsRecord(),
        updatedAt: new Date().toISOString(),
      })
    },
    [gateway, relayBase, cidFile, store]
  )

  // Coalesce per-completion saves into one every PERSIST_INTERVAL_MS. The
  // trailing save always runs, so the last completions of a burst persist too.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistRef = useRef<() => void>(() => undefined)
  persistRef.current = () => persist(cidsText)
  const schedulePersist = useCallback(() => {
    if (persistTimer.current != null) return
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null
      persistRef.current()
    }, PERSIST_INTERVAL_MS)
  }, [])
  // Save now if completions are waiting on the interval; no-op otherwise, so
  // it can run on every tab-hide without recloning an unchanged snapshot.
  const flushPersist = useCallback(() => {
    if (persistTimer.current == null) return
    clearTimeout(persistTimer.current)
    persistTimer.current = null
    persistRef.current()
  }, [])

  // A reload or tab close inside the save interval would drop that batch's
  // completions (they would recompute, but the operator sees the count dip).
  // Hidden is the last reliable moment to write.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushPersist()
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [flushPersist])

  // Persist input edits (debounced) so a refresh keeps the CID list and source
  // settings even before a run starts.
  useEffect(() => {
    const t = setTimeout(() => persist(cidsText), 500)
    return () => clearTimeout(t)
  }, [cidsText, persist])

  const pasted = useMemo(
    () =>
      cidsText
        .split(/\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    [cidsText]
  )
  const cids = useMemo(() => dedupeCanonical(pasted.concat(cidFile?.intake.cids ?? [])), [pasted, cidFile])
  // Loaded files report their invalid lines at parse time; the textarea gets
  // the same treatment here so a stray header row is named before Prepare.
  const invalidPasted = useMemo(() => invalidCidStrings(pasted), [pasted])

  // The hosted console caps a run; a `serve` daemon runs uncapped. The count
  // cap binds here at intake, the byte cap inside the pool once sizes exist.
  const limits = useMemo(() => runLimits(caps), [caps])
  const cidCapExceeded = overCidCap(cids.length, limits)

  const counts = store.counts()
  // Stable between completions: the store rebuilds this only when a row
  // entered or left the done state, so effects keyed on it stay quiet.
  const results = store.resultsList()
  // The most recently finished piece — what Continuity shows.
  const latest = store.lastDone()
  const errors = counts.error
  const walletNetwork = wallet == null ? null : networkOf(wallet.chainId)
  const onTargetNetwork = walletNetwork === targetNetwork
  const isTestnet = targetNetwork !== 'mainnet'
  // A `serve` daemon operates on one network and the console follows it.
  // Otherwise the choice stays open until something is keyed to a network:
  // the session key and the submit record both are.
  const netLocked = caps.backend === 'local' || running || submitting || session != null || submitState != null
  const allCommitted =
    submitState != null && submitState.contexts.length > 0 && submitState.contexts.every((c) => c.phase === 'done')

  // Which step owns the main column. A submit run (live or restored) keeps a
  // returner at the submit step; the consent flags are implied then.
  const submitStarted = submitState != null || resumable != null
  const effectiveReviewed = reviewedPrepare || submitStarted
  const effectiveAccepted = costAccepted || submitStarted
  const canSign = wallet != null && onTargetNetwork && payments != null && readyToSign(payments) && session != null
  const filSymbol = (walletNetwork ?? targetNetwork) === 'calibration' ? 'tFIL' : 'FIL'
  const stage = deriveStage({
    prepareStarted: counts.total > 0,
    running,
    preparedCount: results.length,
    reviewedPrepare: effectiveReviewed,
    costAccepted: effectiveAccepted,
    canSign,
    submitStarted,
    allCommitted,
  })
  // A peek is a look back at a completed step; any real advance ends it.
  // biome-ignore lint/correctness/useExhaustiveDependencies(stage): the deps ARE the trigger — a stage change or the wallet becoming ready ends a peek.
  // biome-ignore lint/correctness/useExhaustiveDependencies(canSign): same trigger.
  useEffect(() => setPeek(null), [stage, canSign])
  const shown: Stage = peek ?? stage

  // Cost estimate: prepared bytes x copies against the service's rate. The
  // rate is a public contract read, fetched once per network on gate entry.
  const totalBytes = useMemo(() => results.reduce((sum, r) => sum + r.rawSize, 0), [results])
  // biome-ignore lint/correctness/useExhaustiveDependencies(targetNetwork): a network switch invalidates the read rate.
  useEffect(() => {
    setRate(null)
    setRateError(null)
  }, [targetNetwork])
  useEffect(() => {
    if (stage !== 'cost' || rate != null || rateError != null) return
    let stale = false
    readStorageRate(targetNetwork)
      .then((r) => {
        if (!stale) setRate(r)
      })
      .catch((err) => {
        if (!stale) setRateError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      stale = true
    }
  }, [stage, targetNetwork, rate, rateError])
  const estimate = rate == null ? null : estimateCostUsdfc(totalBytes, copies, rate, months)
  const costLabel =
    estimate == null || estimate === 0n
      ? null
      : `≈${fmtToken(estimate, 'USDFC')} / ${months === 1 ? 'month' : `${months} months`}`
  const entries = historyEntries(stage, {
    cidCount: counts.total > 0 ? counts.total : cids.length,
    preparedCount: results.length,
    prepareTotal: counts.total,
    costLabel,
    dataSetCount: (submitState?.contexts ?? []).filter((c) => c.dataSetId != null).length,
  })

  const fundingInputs = useMemo(
    () => ({
      providerDetected: injectedProvider() != null,
      connected: wallet != null,
      onTargetNetwork,
      networkLabel: NETWORKS[targetNetwork].label,
      payments,
      requiredUsdfc: estimate,
      signingEnabled: session != null && sessionCanPresign(session),
      filSymbol,
    }),
    [wallet, onTargetNetwork, targetNetwork, payments, estimate, session, filSymbol]
  )
  const checklist = fundingChecklist(fundingInputs)
  useEffect(() => {
    if (stage === 'wallet') reportFundingState(deriveFundingState(fundingInputs))
  }, [stage, fundingInputs])

  // Funnel signals: who finishes a run, who gets pointed at the CLI. Both
  // no-op everywhere except the hosted production site (see analytics.ts).
  useEffect(() => {
    if (allCommitted) trackOnce('run-completed')
  }, [allCommitted])
  useEffect(() => {
    if (cidCapExceeded || byteCapHit) trackOnce('cli-steer')
  }, [cidCapExceeded, byteCapHit])
  // Funnel position for drop-off dashboards and the page-close beacon; the
  // telemetry module owns all dedupe and bucketing decisions.
  useEffect(() => {
    reportFunnelState({
      cidCount: cids.length,
      walletConnected: wallet != null,
      preparing: running,
      preparedDone: counts.done,
      prepareTotal: counts.total,
      prepareErrors: counts.error,
      costAccepted: effectiveAccepted,
      submitting,
      runCompleted: allCommitted,
    })
  }, [
    cids.length,
    wallet,
    running,
    counts.done,
    counts.total,
    counts.error,
    effectiveAccepted,
    submitting,
    allCommitted,
  ])

  // Long runs: keep the screen awake and confirm accidental closes while
  // prepare or submit is in flight. Closing stays safe — both resume.
  useTabLifetime(running || submitting)

  // Follow account and chain changes made inside the wallet. Spending is
  // authorized against the connected account, so a stale address here would
  // show one account's balances while a session key signs for another.
  useEffect(() => {
    if (wallet == null) return
    return onWalletChange(() => {
      refreshWallet()
        .then(setWallet)
        .catch(() => setWallet(null))
    })
  }, [wallet])

  // Payment-readiness reads (#23 signing prerequisites). Public-RPC reads on
  // the connected address — nothing is signed; re-read whenever the wallet or
  // its network changes.
  useEffect(() => {
    setPayments(null)
    setPaymentsError(null)
    setPaymentsLoading(false)
    if (wallet == null) return
    const network = networkOf(wallet.chainId)
    if (network == null) return
    let stale = false
    setPaymentsLoading(true)
    readPaymentsStatus(wallet.address, network)
      .then((s) => {
        if (!stale) setPayments(s)
      })
      .catch((err) => {
        if (!stale) setPaymentsError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!stale) setPaymentsLoading(false)
      })
    return () => {
      stale = true
    }
  }, [wallet])

  // Restore a stored signing session for this wallet+network (#23). Chain
  // reads are authoritative: resumeSession validates both granted permissions
  // and wipes a dead record itself.
  useEffect(() => {
    setSession(null)
    setSessionError(null)
    if (wallet == null) return
    const network = networkOf(wallet.chainId)
    if (network !== targetNetwork) return
    let stale = false
    resumeSession(wallet, network)
      .then((s) => {
        if (!stale && s != null) setSession(s)
      })
      .catch(() => {
        // a failed resume is just "no session" — the grant flow stays offered
      })
    return () => {
      stale = true
    }
  }, [wallet, targetNetwork])

  // Without a wallet the saved submit still renders read-only so verify-on-chain
  // (an account-less RPC read) can answer "is everything on FOC?" — the resume
  // path stays wallet-bound; this only surfaces the record.
  useEffect(() => {
    if (wallet != null) return
    let stale = false
    loadSubmit().then((saved) => {
      if (!stale && saved != null) setSubmitState((current) => current ?? submitStateFromSaved(saved))
    })
    return () => {
      stale = true
    }
  }, [wallet])

  // A previous submit run for exactly this wallet+network+piece set resumes
  // instead of restarting — its presigns and any submitted commits are bound
  // to all three. Shown read-only until the operator presses Submit again.
  // The same partition submit uses: a saved submit is keyed to its piece
  // list, so the resume check must see exactly what Submit would send.
  const submittable = useMemo(() => partitionSubmittable(results), [results])

  useEffect(() => {
    setResumable(null)
    // Not while preparing: results grows all run long, and re-checking the
    // saved submit against a million-piece list on every batch is pure churn.
    if (wallet == null || submittable.eligible.length === 0 || !onTargetNetwork || running) return
    let stale = false
    findResumableSubmit(wallet, targetNetwork, submittable.eligible).then((saved) => {
      if (stale || saved == null) return
      setResumable(saved)
      setCopies(saved.copies)
      setSubmitState((current) => current ?? submitStateFromSaved(saved))
    })
    return () => {
      stale = true
    }
  }, [wallet, onTargetNetwork, submittable, targetNetwork, running])

  const submitWith = useCallback(
    async (excludePieceCids: string[] | null) => {
      if (wallet == null || session == null || results.length === 0) return
      // Gap-filled pieces never ride into submit: the provider pulls the CAR
      // URL, and a URL that served an incomplete CAR during prepare can fail
      // the on-chain add. Retry clears a row once its stream comes back clean.
      const { eligible } = submittable
      if (eligible.length === 0) return
      const pieces =
        excludePieceCids == null ? eligible : eligible.filter((r) => !excludePieceCids.includes(r.pieceCid))
      if (pieces.length === 0) return
      setSubmitError(null)
      setSubmitBlocked(null)
      setSubmitting(true)
      try {
        const prior = await findResumableSubmit(wallet, targetNetwork, pieces)
        const finished = await runSubmit({
          wallet,
          network: targetNetwork,
          session,
          pieces,
          copies: prior?.copies ?? copies,
          prior,
          onUpdate: setSubmitState,
        })
        setResumable(await findResumableSubmit(wallet, targetNetwork, pieces))
        return finished
      } catch (err) {
        if (err instanceof SubmitBlockedError) {
          setSubmitBlocked(err.reason)
        }
        setSubmitError(err instanceof Error ? err.message : String(err))
      } finally {
        setSubmitting(false)
      }
    },
    [wallet, session, results, submittable, copies, targetNetwork]
  )

  const submit = useCallback(() => void submitWith(null), [submitWith])

  const discardSubmit = useCallback(() => {
    void clearSubmit()
    setResumable(null)
    setSubmitState(null)
    setSubmitError(null)
    setSubmitBlocked(null)
  }, [])

  const extend = useCallback(async () => {
    if (wallet == null || session == null) return
    setSessionError(null)
    setSessionBusy('extending…')
    try {
      const s = await extendSession(wallet, targetNetwork, session, DEFAULT_SESSION_DURATION_SECONDS, () =>
        setSessionBusy('confirming…')
      )
      setSession(s)
      setSubmitBlocked((b) => (b === 'session-margin' ? null : b))
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err))
    } finally {
      setSessionBusy(null)
    }
  }, [wallet, session, targetNetwork])

  const grant = useCallback(async () => {
    if (wallet == null) return
    setSessionError(null)
    setSessionBusy('authorizing…')
    try {
      const s = await grantSession(wallet, targetNetwork, sessionDuration, () => setSessionBusy('confirming…'))
      setSession(s)
    } catch (err) {
      reportSigningDeclined()
      setSessionError(err instanceof Error ? err.message : String(err))
    } finally {
      setSessionBusy(null)
    }
  }, [wallet, sessionDuration, targetNetwork])

  const revoke = useCallback(async () => {
    if (wallet == null || session == null) return
    setSessionError(null)
    setSessionBusy('revoking…')
    try {
      await revokeSession(wallet, targetNetwork, session, () => setSessionBusy('confirming revoke…'))
      setSession(null)
    } catch (err) {
      // Chain-first revoke failed — the key stays usable and revocable.
      setSessionError(err instanceof Error ? err.message : String(err))
    } finally {
      setSessionBusy(null)
    }
  }, [wallet, session, targetNetwork])

  const connect = useCallback(async () => {
    setWalletError(null)
    try {
      setWallet(await connectWallet())
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const switchNet = useCallback(async () => {
    setWalletError(null)
    try {
      await switchToNetwork(targetNetwork)
      setWallet(await refreshWallet())
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : String(err))
    }
  }, [targetNetwork])

  // Live AbortControllers by CID — the stall watchdog and the per-row cancel
  // button abort through these (#43).
  const prepareControllers = useRef(new Map<string, AbortController>())
  // Rows whose byte counter has been quiet past STALL_HINT_MS, keyed to the
  // phase the silence is in; the row renders the matching reassurance.
  const [stalledRows, setStalledRows] = useState<ReadonlyMap<string, PreparePhase>>(new Map())
  const noteStall = useCallback((cid: string, p: PreparePhase) => {
    setStalledRows((m) => (m.get(cid) === p ? m : new Map(m).set(cid, p)))
  }, [])
  const clearStall = useCallback((cid: string) => {
    setStalledRows((m) => {
      if (!m.has(cid)) return m
      const next = new Map(m)
      next.delete(cid)
      return next
    })
  }, [])

  // Roots whose last attempt failed: their next lookup skips the learned
  // routing answer, in case a stale source list is what failed them.
  const discoveryBypass = useRef(new Set<string>())
  const lookupSources = useCallback((cid: string) => {
    const canonical = toCanonicalCidV1(cid)
    if (canonical == null) return undefined
    return discoverRootSources(canonical, undefined, discoveryBypass.current.delete(cid))
  }, [])

  // Compute one CID's piece and patch its row through the phases. Shared by
  // the Prepare worker pool and the per-row Retry action (#34).
  const prepareOne = useCallback(
    async (cid: string, sources?: Promise<RootSources>) => {
      sources ??= lookupSources(cid)
      const startedAt = performance.now()
      let lastEmit = 0
      store.markWorking(cid, 0, 0)
      const controller = new AbortController()
      prepareControllers.current.set(cid, controller)
      // Every progress callback means the byte counter advanced (the exporter
      // reports cumulative size per chunk). No advance for the stall window →
      // abort with a retryable error and free the worker slot.
      let lastAdvanceAt = performance.now()
      // The byte counter freezes the same way for a silent CAR stream and a
      // stuck hash pool; the phase names which one so the operator (and the
      // origin breaker) chase the right side.
      let phase: PreparePhase = 'retrieve'
      const watchdog = setInterval(() => {
        const budget = phase === 'hash-claim' ? CLAIM_STALL_TIMEOUT_MS : STALL_TIMEOUT_MS
        const silent = performance.now() - lastAdvanceAt
        if (silent > budget) {
          controller.abort(new Error(stallMessage(phase, Math.round(budget / 1000))))
        } else if (silent > STALL_HINT_MS) {
          noteStall(cid, phase)
        }
      }, STALL_POLL_MS)
      try {
        const result = await computePiece(
          gateway,
          cid,
          relayBase,
          (bytes) => {
            const now = performance.now()
            lastAdvanceAt = now
            clearStall(cid)
            if (now - lastEmit < PROGRESS_THROTTLE_MS) return
            lastEmit = now
            const secs = (now - startedAt) / 1000
            store.markWorking(cid, bytes, secs > 0 ? bytes / 1048576 / secs : 0)
          },
          controller.signal,
          sources,
          (p) => {
            phase = p
            // A phase transition is progress: without this, a piece leaving a
            // long (in-budget) hash-claim wait carries a stale byte clock into
            // hash-write's tighter budget and dies on the next poll.
            lastAdvanceAt = performance.now()
          }
        )
        store.markDone(cid, result)
        schedulePersist()
      } catch (err) {
        const failure = describePrepareFailure(err)
        store.markError(cid, failure.headline, failure.detail)
        discoveryBypass.current.add(cid)
      } finally {
        clearInterval(watchdog)
        clearStall(cid)
        prepareControllers.current.delete(cid)
      }
    },
    [gateway, relayBase, schedulePersist, store, lookupSources, noteStall, clearStall]
  )

  const cancelOne = useCallback((cid: string) => {
    prepareControllers.current.get(cid)?.abort(new Error('cancelled. Retry whenever you like.'))
  }, [])

  // Shared worker pool: run() feeds it everything unprepared, retryFailed()
  // only the failures. prepareOne resolves on every path (its catch maps
  // failures to row state), but `running` must never stick at true: the
  // finally keeps the button honest even if a future edit lets a worker
  // reject.
  const runPool = useCallback(
    async (pending: string[]) => {
      ranRef.current = true
      setRunning(true)
      setByteCapHit(false)
      // While the run is live the in-flight rows are the progress view, so
      // the table follows them. When it ends that filter would show nothing;
      // land on the failures if there are any, since those carry the run's
      // next action.
      setRowFilter('working')
      setRowPage(0)
      let next = 0
      // Keep the routing lookup off every root's critical path: discovery for
      // the next pool-width of roots runs while the current ones fetch, so a
      // worker picks up an answered (or answering) lookup instead of starting
      // one. Cold-slice timing put the lookup at ~40% of a median root's
      // wall-clock when it starts on pickup. The map holds at most
      // CONCURRENCY in-flight lookups (entries are deleted on pickup), each a
      // single small routing GET that resolves to a handful of URLs.
      // `discoverRootSources` never rejects; a failed or timed-out lookup is
      // an empty answer, exactly as if the worker had asked itself. A lookup
      // for a root that later gets cancelled just resolves unused inside its
      // own 5s timeout.
      const sourcesFor = new Map<string, Promise<RootSources>>()
      let discoverNext = 0
      const topUpDiscovery = () => {
        while (discoverNext < pending.length && discoverNext < next + CONCURRENCY) {
          const cid = pending[discoverNext++]
          // An invalid CID gets no lookup; prepareOne surfaces the error.
          const lookup = lookupSources(cid)
          if (lookup != null) sourcesFor.set(cid, lookup)
        }
      }
      // Hosted byte cap: sizes only exist once roots finish, so the pool
      // checks the prepared total before admitting each next root. Roots
      // already in flight finish; the rest stay queued and the notice below
      // the run points larger sets at the CLI.
      let capStopped = false
      const admitNext = () => {
        if (limits == null) return true
        if (capStopped) return false
        const prepared = store.resultsList().reduce((sum, r) => sum + r.rawSize, 0)
        if (!overByteCap(prepared, limits)) return true
        capStopped = true
        setByteCapHit(true)
        return false
      }
      const worker = async () => {
        while (next < pending.length) {
          if (!admitNext()) break
          const cid = pending[next++]
          topUpDiscovery()
          const sources = sourcesFor.get(cid)
          sourcesFor.delete(cid)
          await prepareOne(cid, sources)
        }
      }
      try {
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker))
      } finally {
        setRunning(false)
        setRowFilter((f) => (f === 'working' ? (store.counts().error > 0 ? 'error' : 'all') : f))
        flushPersist()
      }
    },
    [prepareOne, flushPersist, store, lookupSources, limits]
  )

  const run = useCallback(async () => {
    ranRef.current = true
    setReviewedPrepare(false)
    setCostAccepted(false)
    setPeek(null)
    // Prune saved results for CIDs no longer in the input, then seed done rows
    // from the saved run — pieces are deterministic, so a saved result is final
    // and only the pending/failed CIDs go back through a worker.
    store.setCids(cids)
    persist(cidsText)
    await runPool(cids.filter((cid) => !store.hasResult(cid)))
  }, [cids, cidsText, persist, runPool, store])

  // Requeue exactly the failures (#57): on a large run they are the rows the
  // operator is looking at, and Prepare would also recompute everything
  // still queued.
  const retryFailed = useCallback(async () => {
    await runPool(store.listFor('error'))
  }, [runPool, store])

  // Parse a picked or dropped cids.txt. Streaming, so the only state the tab
  // holds afterward is the accepted list and the reject summary.
  const loadCidFile = useCallback(async (file: File) => {
    setCidFileError(null)
    setCidFileBusy(true)
    try {
      const intake = await parseCidFile(file)
      if (intake.cids.length === 0) {
        setCidFile(null)
        setCidFileError(
          intake.invalidCount > 0
            ? `no valid CIDs in ${file.name}. ${intake.invalidCount} line(s) rejected (line ${intake.invalidSamples[0].line}: "${intake.invalidSamples[0].text}")`
            : `no CIDs in ${file.name}`
        )
        return
      }
      setCidFile({ name: file.name, intake })
    } catch (err) {
      setCidFile(null)
      setCidFileError(`could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCidFileBusy(false)
    }
  }, [])

  const clearCidFile = useCallback(() => {
    setCidFile(null)
    setCidFileError(null)
  }, [])

  const reset = useCallback(() => {
    store.clear()
    setRowFilter('all')
    setRowPage(0)
    setByteCapHit(false)
    setCidsText('')
    setCidFile(null)
    setCidFileError(null)
    setRestored(false)
    setReviewedPrepare(false)
    setCostAccepted(false)
    setPeek(null)
    setSubmitState(null)
    setResumable(null)
    setSubmitError(null)
    setSubmitBlocked(null)
    void clearRun()
    void clearSubmit()
  }, [store])

  const copy = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200)
    })
  }, [])

  const saveManifest = useCallback(() => {
    downloadManifest(
      buildManifest(results, {
        tool: 'ipfs2foc-app',
        network: targetNetwork,
        relayBase,
        gateway,
        now: new Date().toISOString(),
      })
    )
  }, [results, relayBase, gateway, targetNetwork])

  // Pieces no provider could fetch this run (deduped across copies) — the
  // committable rest already landed; these get a retry and a remainder.
  const deferredCids = useMemo(
    () => [...new Set((submitState?.contexts ?? []).flatMap((c) => c.deferredPieceCids ?? []))],
    [submitState]
  )

  const saveDeferredManifest = useCallback(() => {
    const set = new Set(deferredCids)
    downloadManifest(
      buildManifest(
        results.filter((r) => set.has(r.pieceCid)),
        { tool: 'ipfs2foc-app', network: targetNetwork, relayBase, gateway, now: new Date().toISOString() }
      )
    )
  }, [deferredCids, results, relayBase, gateway, targetNetwork])

  const retryDeferred = useCallback(async () => {
    if (wallet == null) return
    const saved = await findResumableSubmit(wallet, targetNetwork, results)
    if (saved == null) return
    setResumable(await requeueDeferred(saved))
    void submitWith(null)
  }, [wallet, results, submitWith, targetNetwork])

  // Verify-on-chain (#47): account-less reads of the data set's active pieces
  // and proving status, keyed per provider context. The chain is the only
  // signal that may flip a piece's state here — never a gateway probe.
  const [verifying, setVerifying] = useState<string | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [verifyReports, setVerifyReports] = useState<
    Record<string, { result: VerifyResult; network: 'mainnet' | 'calibration'; dataSetId: string; cleared: number }>
  >({})

  const verifyContext = useCallback(async (providerId: string) => {
    setVerifyError(null)
    setVerifying(providerId)
    try {
      // The saved record (not React state) is the source of truth: it carries
      // the chain id, every chunk's pieces, and the deferred set.
      const saved = await loadSubmit()
      const c = saved?.contexts.find((x) => x.providerId === providerId)
      if (saved == null || c?.dataSetId == null) throw new Error('no saved run with a data set for this provider')
      const network = networkOf(saved.chainId)
      if (network == null) throw new Error(`saved run is on an unknown chain (id ${saved.chainId})`)
      const prepared = [...new Set([...c.chunks.flatMap((ch) => ch.pieceCids), ...(c.deferredPieceCids ?? [])])]
      const txHashes = c.chunks.flatMap((ch) => (ch.txHash == null ? [] : [ch.txHash]))
      const result = await verifyDataSet({
        rpcUrl: RPC_URLS[network],
        network,
        dataSetId: Number(c.dataSetId),
        preparedPieceCids: prepared,
        txHashes,
      })
      // A deferred piece the chain holds was committed on another surface
      // (or a forgotten retry landed) — record it as a committed chunk so the
      // skipped banner clears and resume never re-queues it.
      const settled = (c.deferredPieceCids ?? []).filter((p) => result.found.has(p))
      if (settled.length > 0) {
        const remaining = (c.deferredPieceCids ?? []).filter((p) => !result.found.has(p))
        c.deferredPieceCids = remaining.length > 0 ? remaining : undefined
        c.chunks.push({ pieceCids: settled, pullComplete: true, committed: true })
        saved.updatedAt = new Date().toISOString()
        await saveSubmit(saved)
        setSubmitState(submitStateFromSaved(saved))
        setResumable((prev) => (prev == null ? prev : saved))
      }
      setVerifyReports((prev) => ({
        ...prev,
        [providerId]: { result, network, dataSetId: c.dataSetId as string, cleared: settled.length },
      }))
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err))
    } finally {
      setVerifying(null)
    }
  }, [])

  const queuedCount = counts.queued
  // The filtered CID list and the page of it that renders. Both are cheap
  // reads: the store caches the list until membership changes, and only one
  // page of rows ever reaches the DOM.
  const filteredCids = store.listFor(rowFilter)
  const pageSize = rowFilter === 'working' ? WORKING_PAGE_SIZE : PAGE_SIZE
  const pageCount = Math.max(1, Math.ceil(filteredCids.length / pageSize))
  const page = Math.min(rowPage, pageCount - 1)
  const pageStart = page * pageSize
  const pageCids = filteredCids.slice(pageStart, pageStart + pageSize)

  // Completions per second over the trailing window → time left. Samples
  // append only when the processed count moves, but the rate reads against
  // the clock, so a stalling source shows a growing estimate instead of a
  // frozen one. Held back until there is enough signal to mean something.
  const processed = counts.done + counts.error
  const etaSamples = useRef<Array<{ t: number; n: number }>>([])
  const longRunLatch = useRef(false)
  useEffect(() => {
    if (!running) {
      etaSamples.current = []
      longRunLatch.current = false
      return
    }
    const now = performance.now()
    etaSamples.current.push({ t: now, n: processed })
    while (etaSamples.current.length > 2 && etaSamples.current[0].t < now - ETA_WINDOW_MS) {
      etaSamples.current.shift()
    }
  }, [processed, running])
  const eta = (() => {
    if (!running || etaSamples.current.length < 2) return null
    const first = etaSamples.current[0]
    const last = etaSamples.current[etaSamples.current.length - 1]
    const elapsed = (performance.now() - first.t) / 1000
    const gained = last.n - first.n
    if (elapsed < 15 || gained < 5) return null
    const rate = gained / elapsed
    const remaining = counts.queued + counts.working
    if (remaining <= 0) return null
    const seconds = remaining / rate
    return { rate, seconds, text: fmtEta(seconds) }
  })()
  // Long-run note: latches the first time the projection crosses the
  // threshold and stays for the rest of the run (see latchLongRun). The
  // minutes figure keeps tracking the live estimate.
  longRunLatch.current = latchLongRun(longRunLatch.current, eta?.seconds ?? null)
  const longRun = running && longRunLatch.current
  useEffect(() => {
    if (longRun) trackOnce('cli-steer')
  }, [longRun])

  // Submit ETA: committed chunks over time → time left for the rest. Chunks
  // land about a minute apart, so an estimate exists only after the second
  // commit and follows the observed pace rather than an assumed one.
  const submitEtaSamples = useRef<Map<string, Array<{ t: number; n: number }>>>(new Map())
  useEffect(() => {
    if (submitState == null) {
      submitEtaSamples.current.clear()
      return
    }
    const now = performance.now()
    for (const c of submitState.contexts) {
      const n = c.chunks.filter((ch) => ch.committed === true).length
      const samples = submitEtaSamples.current.get(c.providerId) ?? []
      if (samples.length === 0 || samples[samples.length - 1].n !== n) {
        samples.push({ t: now, n })
        submitEtaSamples.current.set(c.providerId, samples)
      }
    }
  }, [submitState])
  const submitEtaFor = (c: SubmitContextStatus): string => {
    if (c.phase === 'done' || c.phase === 'failed' || c.chunks.length < 2) return ''
    const remaining = c.chunks.filter((ch) => ch.committed !== true).length
    const secs = chunkEtaSeconds(submitEtaSamples.current.get(c.providerId) ?? [], remaining)
    return secs == null ? '' : ` · ${fmtEta(secs)} left`
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#start">
        Skip to the migration steps
      </a>
      <div aria-hidden className="grid-overlay" />
      <header className="masthead">
        <div className="brand">
          <FocMark size={38} />
          <span className="brand-text">
            <span className="mark">ipfs2foc</span>
            <span className="sub">Filecoin Onchain Cloud</span>
          </span>
        </div>
        <span className={`net-badge ${isTestnet ? 'is-test' : ''}`}>
          <Led color={isTestnet ? 'var(--alert)' : 'var(--accent)'} on />
          <label htmlFor="network">
            <span className="sr-only">Network</span>
          </label>
          <select
            disabled={netLocked}
            id="network"
            onChange={(e) => setTargetNetwork(e.target.value as NetworkKey)}
            title={netLocked ? 'The network is fixed while a run is in flight' : 'Choose the network for this run'}
            value={targetNetwork}
          >
            {(Object.keys(NETWORKS) as NetworkKey[]).map((k) => (
              <option key={k} value={k}>
                {k === 'mainnet' ? 'Mainnet' : 'Calibration testnet'}
              </option>
            ))}
          </select>
        </span>
      </header>

      {shown === 'intake' && <Lede limits={limits} />}

      <div className={`flow${entries.length === 0 ? ' no-hist' : ''}`} id="start">
        <HistoryChrome active={stage} entries={entries} onPeek={setPeek} peek={peek} />
        <div className="flow-main">
          {shown === 'wallet' && (
            <section className="panel">
              <div className="panel-head">
                <span className={`panel-no ${canSign ? 'is-done' : 'is-current'}`}>04</span>
                <h2>Wallet &amp; funds</h2>
                <span className="panel-note">
                  {costLabel == null
                    ? 'Nothing is stored without your approval.'
                    : `${costLabel} · nothing is stored without your approval.`}
                </span>
              </div>
              {wallet != null && (
                <div className="wallet-row">
                  <div className="wallet-on">
                    <code className="addr">{short(wallet.address, 8, 6)}</code>
                    <span className={`chip ${onTargetNetwork ? 'chip-ok' : 'chip-warn'}`}>
                      {walletNetwork ? NETWORKS[walletNetwork].label : `chain ${wallet.chainId}`}
                    </span>
                  </div>
                </div>
              )}
              <div className="pay-status fund-list">
                {checklist.map((row) => (
                  <div className={`fund-row is-${row.state}`} key={row.id}>
                    <Led color={row.state === 'done' ? 'var(--ok)' : 'var(--warn)'} on={row.state !== 'waiting'} />
                    <span className="fund-title">{row.title}</span>
                    {row.detail != null && <span className="fund-detail dim">{row.detail}</span>}
                    {row.state === 'blocked' && (
                      <span className="fund-action">
                        {row.id === 'wallet' && (
                          <a href="https://metamask.io" rel="noreferrer" target="_blank">
                            Install MetaMask
                          </a>
                        )}
                        {row.id === 'connect' &&
                          (wallet == null ? (
                            <button className="btn small primary" onClick={connect} type="button">
                              Connect wallet
                            </button>
                          ) : (
                            <button className="btn small" onClick={switchNet} type="button">
                              Switch to {NETWORKS[targetNetwork].label}
                            </button>
                          ))}
                        {row.id === 'fil' && (
                          <a href="https://docs.filecoin.io/basics/assets/get-fil" rel="noreferrer" target="_blank">
                            Get {filSymbol}
                          </a>
                        )}
                        {/* Seam for the self-funding epic: this link becomes the in-app
                            top-up flow when that ships. */}
                        {row.id === 'usdfc' && (
                          <a
                            href="https://github.com/FilOzone/ipfs2foc#network-gas-and-payments"
                            rel="noreferrer"
                            target="_blank"
                          >
                            Get and deposit USDFC
                          </a>
                        )}
                        {row.id === 'approve' && (
                          <a
                            href="https://github.com/FilOzone/ipfs2foc#network-gas-and-payments"
                            rel="noreferrer"
                            target="_blank"
                          >
                            Approve in the setup guide
                          </a>
                        )}
                      </span>
                    )}
                  </div>
                ))}
                {walletError && <span className="err-text">{walletError}</span>}
                {paymentsLoading && <span className="dim">reading payment status…</span>}
                {paymentsError != null && (
                  <span className="err-text" title={paymentsError}>
                    payment status unavailable: {short(paymentsError, 48, 0)}
                  </span>
                )}
                {wallet != null &&
                  walletNetwork != null &&
                  payments != null &&
                  readyToSign(payments) &&
                  onTargetNetwork && (
                    <>
                      <span className="pay-label">signing session</span>
                      {session == null ? (
                        <span className="pay-value session-controls">
                          <select
                            disabled={sessionBusy != null}
                            onChange={(e) => setSessionDuration(BigInt(e.target.value))}
                            value={sessionDuration.toString()}
                          >
                            {SESSION_DURATIONS.map((d) => (
                              <option key={d.label} value={d.seconds.toString()}>
                                {d.label}
                              </option>
                            ))}
                          </select>
                          <button className="btn small" disabled={sessionBusy != null} onClick={grant} type="button">
                            {sessionBusy ?? 'Enable signing'}
                          </button>
                        </span>
                      ) : (
                        <span className="pay-value session-controls">
                          <Led color={sessionCanPresign(session) ? 'var(--ok)' : 'var(--warn)'} on />
                          <span>
                            until {fmtExpiry(session.expiresAt)} · <code>{short(session.sessionAddress, 6, 4)}</code>
                          </span>
                          <button className="btn small" disabled={sessionBusy != null} onClick={extend} type="button">
                            Extend +24h
                          </button>
                          <button className="btn small" disabled={sessionBusy != null} onClick={revoke} type="button">
                            Revoke
                          </button>
                          {sessionBusy != null && <span className="dim">{sessionBusy}</span>}
                        </span>
                      )}
                      {session == null ? (
                        <SessionGrantExplainer
                          availableLabel={fmtToken(payments.availableUsdfc, 'USDFC')}
                          longWindow={sessionDuration > 86_400n}
                        />
                      ) : sessionCanPresign(session) ? null : (
                        <SessionExpiryNote />
                      )}
                    </>
                  )}
                {sessionError != null && (
                  <span className="err-text" title={sessionError}>
                    session: {short(sessionError, 64, 0)}
                  </span>
                )}
              </div>
            </section>
          )}

          {shown === 'intake' && (
            <section className="panel">
              <div className="panel-head">
                <span className={`panel-no ${counts.total > 0 ? 'is-done' : cids.length > 0 ? 'is-current' : ''}`}>
                  01
                </span>
                <h2>CIDs</h2>
                <span aria-live="polite" className="panel-note">
                  {cids.length === 0 ? '' : `${cids.length.toLocaleString()} unique`}
                </span>
              </div>
              <label className="input-label" htmlFor="cids">
                The CIDs you want on Filecoin
              </label>
              <textarea
                className="cid-input"
                id="cids"
                onChange={(e) => setCidsText(e.target.value)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const file = e.dataTransfer.files[0]
                  if (file == null) return
                  e.preventDefault()
                  void loadCidFile(file)
                }}
                placeholder={'bafybei…\nQm…  (CIDv0 or CIDv1, one per line)\nor drop a cids.txt file here'}
                spellCheck={false}
                value={cidsText}
              />
              <InvalidCidNote invalid={invalidPasted} />
              <div className="file-intake">
                <label className="btn small">
                  {cidFileBusy ? 'Reading…' : 'Load cids.txt'}
                  <input
                    accept=".txt,.csv,text/plain"
                    disabled={cidFileBusy || running}
                    hidden
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      e.target.value = ''
                      if (file != null) void loadCidFile(file)
                    }}
                    type="file"
                  />
                </label>
                {cidFile != null && (
                  <>
                    <span className="panel-note">
                      {cidFile.intake.cids.length.toLocaleString()} CIDs from {cidFile.name}
                      {cidFile.intake.invalidCount > 0 &&
                        ` · ${cidFile.intake.invalidCount.toLocaleString()} invalid line(s) skipped` +
                          (cidFile.intake.invalidSamples.length > 0
                            ? ` (first: line ${cidFile.intake.invalidSamples[0].line} "${cidFile.intake.invalidSamples[0].text}")`
                            : '')}
                    </span>
                    <button className="btn small" disabled={running} onClick={clearCidFile} type="button">
                      Remove file
                    </button>
                  </>
                )}
                {cidFileError != null && <span className="err-text">{cidFileError}</span>}
              </div>
              <details className="advanced">
                <summary>Sources</summary>
                <label className="field">
                  <span>Gateway</span>
                  <input onChange={(e) => setGateway(e.target.value)} spellCheck={false} value={gateway} />
                </label>
                <label className="field">
                  <span>Redirect relay</span>
                  <input onChange={(e) => setRelayBase(e.target.value)} spellCheck={false} value={relayBase} />
                </label>
              </details>
              <div className="actions">
                <button
                  className="btn primary"
                  disabled={running || cids.length === 0 || cidCapExceeded}
                  onClick={run}
                  type="button"
                >
                  {running
                    ? 'Preparing…'
                    : cids.length === 0
                      ? 'Prepare'
                      : `Prepare ${cids.length.toLocaleString()} item${cids.length === 1 ? '' : 's'}`}
                </button>
                {(cids.length > 0 || counts.total > 0) && (
                  <button className="btn small" disabled={running} onClick={reset} type="button">
                    Clear
                  </button>
                )}
              </div>
              {cidCapExceeded && limits != null && <CidCapNotice count={cids.length} limits={limits} />}
            </section>
          )}

          {shown === 'prepare' && counts.total > 0 && (
            <section className="panel">
              <div className="panel-head">
                <span className={`panel-no ${counts.done > 0 && !running ? 'is-done' : running ? 'is-current' : ''}`}>
                  02
                </span>
                <h2>Pieces</h2>
                {/* A prepare run reports for minutes to hours, so its counts are
                announced rather than only painted. */}
                <span aria-live="polite" className="panel-note">
                  {counts.done.toLocaleString()} ready{errors > 0 ? ` · ${errors.toLocaleString()} failed` : ''}
                  {eta == null ? '' : ` · ${eta.rate.toFixed(1)}/s · ${eta.text} left`}
                  {restored ? ' · restored from your last visit' : ''}
                </span>
              </div>
              {byteCapHit && limits != null && <ByteCapNotice limits={limits} />}
              {longRun && limits != null && (
                <LongRunAdvisory minutes={eta == null ? null : Math.max(1, Math.round(eta.seconds / 60))} />
              )}
              {!running && errors > 0 && <FailureSummary errors={errors} total={counts.total} />}
              {/* The newest finished item only: one worked example, not a second
              table. Rendering it per row would double the table's width and
              its cost at the CID counts this tool targets. */}
              {latest != null && (
                <Continuity
                  cid={latest.cid}
                  drawn={running}
                  key={latest.cid}
                  pieceCid={latest.pieceCid}
                  size={fmtBytes(latest.rawSize)}
                />
              )}
              {/* The run at a glance, and the way to the rows that matter: each
              count filters the table to its state. On a large run the
              failures are the only rows anyone reads. */}
              <fieldset aria-label="Filter the table by state" className="state-filter">
                {ROW_FILTERS.map(({ key, label }) => {
                  const count = key === 'all' ? counts.total : counts[key]
                  return (
                    <button
                      aria-pressed={rowFilter === key}
                      className={`btn small filter-chip ${rowFilter === key ? 'is-on' : ''} ${key === 'error' && count > 0 ? 'is-alert' : ''}`}
                      disabled={key !== 'all' && count === 0 && rowFilter !== key}
                      key={key}
                      onClick={() => {
                        setRowFilter(key)
                        setRowPage(0)
                      }}
                      type="button"
                    >
                      {label} {count.toLocaleString()}
                    </button>
                  )
                })}
                {errors > 0 && !running && (
                  <button className="btn small" onClick={() => void retryFailed()} type="button">
                    Retry {errors.toLocaleString()} failed
                  </button>
                )}
              </fieldset>
              <div className="table">
                <div className="trow thead">
                  <span>Your CID</span>
                  <span>Commitment</span>
                  <span className="num">Size</span>
                  <span>Source the provider reads</span>
                </div>
                {pageCids.length === 0 && (
                  <div className="trow">
                    <span className="dim">no items in this state right now</span>
                  </div>
                )}
                {pageCids.map((cid) => {
                  const state = store.getState(cid)
                  // Show the canonical CIDv1 once computed (a `Qm…` input is converted),
                  // so the row reflects exactly what gets committed and relayed.
                  const view =
                    state.phase === 'done'
                      ? {
                          phase: 'done' as const,
                          cid: state.result.cid,
                          pieceCid: state.result.pieceCid,
                          rawSize: state.result.rawSize,
                          sourceUrl: state.result.sourceUrl,
                          gapFillCount: state.result.gapFillCount,
                        }
                      : state.phase === 'error'
                        ? { phase: 'error' as const, cid, message: state.message, detail: state.detail }
                        : state.phase === 'working'
                          ? {
                              phase: 'working' as const,
                              cid,
                              bytes: state.bytes,
                              rate: state.rate,
                              stalledIn: stalledRows.get(cid),
                            }
                          : { phase: 'queued' as const, cid }
                  return (
                    <PieceRow
                      copied={copied === cid}
                      errOpen={errOpen === cid}
                      key={cid}
                      onCancel={() => cancelOne(cid)}
                      onCopy={() => {
                        if (state.phase === 'done') copy(state.result.sourceUrl, cid)
                      }}
                      onRetry={() => void prepareOne(cid)}
                      onToggleError={() => setErrOpen(errOpen === cid ? null : cid)}
                      running={running}
                      view={view}
                    />
                  )
                })}
              </div>
              {filteredCids.length > pageSize && (
                <div className="pager">
                  <button
                    className="btn small"
                    disabled={page === 0}
                    onClick={() => setRowPage(page - 1)}
                    type="button"
                  >
                    ‹ Previous
                  </button>
                  <span className="panel-note">
                    {(pageStart + 1).toLocaleString()}–{(pageStart + pageCids.length).toLocaleString()} of{' '}
                    {filteredCids.length.toLocaleString()}
                  </span>
                  <button
                    className="btn small"
                    disabled={page >= pageCount - 1}
                    onClick={() => setRowPage(page + 1)}
                    type="button"
                  >
                    Next ›
                  </button>
                </div>
              )}
              {errors > 0 && (
                <p className="gate-note">
                  Finished rows are kept: Prepare and per-row retry recompute only what failed. Click a failure to
                  expand the full error; "check availability" shows whether the network can serve that CID at all.
                </p>
              )}
              {!running && queuedCount > 0 && (
                <p className="gate-note">
                  {queuedCount.toLocaleString()} item{queuedCount === 1 ? '' : 's'} not prepared yet. Press Prepare to
                  continue; it picks up exactly where the run stopped and never recomputes a finished row.
                </p>
              )}
              {running && (
                <p className="gate-note">
                  Reloading is safe at any point: finished rows are restored from this browser and Prepare resumes the
                  rest. A row that stops receiving bytes for {Math.round(STALL_TIMEOUT_MS / 60000)} minutes fails on its
                  own and frees the worker; cancel does the same immediately.
                </p>
              )}
              {results.length > 0 && (
                <div className="actions">
                  <button className="btn" onClick={saveManifest} type="button">
                    Download run manifest ({results.length.toLocaleString()})
                  </button>
                  <span className="panel-note">
                    The portable record of this run: pull URLs and commitments for the submit step.
                  </span>
                </div>
              )}
              {!running && !effectiveReviewed && submittable.eligible.length > 0 && (
                <>
                  <div className="actions">
                    <button className="btn primary" onClick={() => setReviewedPrepare(true)} type="button">
                      Review cost ({submittable.eligible.length.toLocaleString()} item
                      {submittable.eligible.length === 1 ? '' : 's'})
                    </button>
                  </div>
                  <p className="gate-note">Next: review cost, then approve in wallet.</p>
                </>
              )}
            </section>
          )}

          {shown === 'cost' && (
            <section className="panel">
              <div className="panel-head">
                <span className={`panel-no ${effectiveAccepted ? 'is-done' : 'is-current'}`}>03</span>
                <h2>Cost</h2>
                <span className="panel-note">Read from the storage service. Nothing is signed here.</span>
              </div>
              <p className="gate-note">
                {results.length.toLocaleString()} of {counts.total.toLocaleString()} prepared
                {errors > 0 ? ` · ${errors.toLocaleString()} need retry or the CLI` : ''}
                {submittable.heldBack.length > 0
                  ? ` · ${submittable.heldBack.length.toLocaleString()} held back until their stream reads complete`
                  : ''}
              </p>
              <div className="actions">
                <span className="session-controls">
                  <span className="copies-label">Copies</span>
                  <select
                    disabled={submitting || resumable != null}
                    onChange={(e) => setCopies(Number(e.target.value))}
                    value={copies}
                  >
                    <option value={1}>1 (single provider)</option>
                    <option value={2}>2 (primary + secondary)</option>
                    <option value={3}>3 (primary + two secondaries)</option>
                  </select>
                </span>
                <span className="session-controls">
                  <span className="copies-label">Store for</span>
                  <select onChange={(e) => setMonths(Number(e.target.value))} value={months}>
                    <option value={1}>1 month</option>
                    <option value={3}>3 months</option>
                    <option value={6}>6 months</option>
                    <option value={12}>12 months</option>
                  </select>
                </span>
              </div>
              {rate == null && rateError == null && <p className="gate-note">reading the current storage rate…</p>}
              {rateError != null && (
                <p className="err-text" title={rateError}>
                  The rate read failed: {short(rateError, 64, 0)}. The wallet step shows balances before anything is
                  signed.
                </p>
              )}
              {estimate != null && (
                <p className="gate-note">
                  Estimated cost: ≈{fmtToken(estimate, 'USDFC')} for {months} month{months === 1 ? '' : 's'} of {copies}{' '}
                  cop{copies === 1 ? 'y' : 'ies'} of {fmtBytes(totalBytes)}. Storage continues as long as the deposited
                  balance funds it, and the exact rate is fixed when the data set is created. See{' '}
                  <a
                    href="https://github.com/FilOzone/ipfs2foc#network-gas-and-payments"
                    rel="noreferrer"
                    target="_blank"
                  >
                    how funding works
                  </a>
                  .
                </p>
              )}
              <div className="actions">
                <button
                  className="btn primary"
                  disabled={submittable.eligible.length === 0}
                  onClick={() => setCostAccepted(true)}
                  type="button"
                >
                  Continue with {submittable.eligible.length.toLocaleString()} item
                  {submittable.eligible.length === 1 ? '' : 's'}
                </button>
              </div>
              <p className="gate-note">Next: approve in wallet.</p>
            </section>
          )}

          {(shown === 'submit' || shown === 'receipt') && (results.length > 0 || submitState != null) && (
            <section className="panel">
              <div className="panel-head">
                <span className={`panel-no ${allCommitted ? 'is-done' : submitting ? 'is-current' : ''}`}>05</span>
                <h2>Submit</h2>
                <span className="panel-note">
                  One on-chain commit per copy, signed by the session key without further prompts.
                </span>
              </div>
              {results.length === 0 ? (
                <p className="gate-note">
                  A previous run's submit state is shown below. Verify it against the chain at any time, or paste that
                  run's CIDs above to resume submitting.
                </p>
              ) : canSign ? (
                <>
                  <div className="actions">
                    <span className="panel-note">
                      {copies} cop{copies === 1 ? 'y' : 'ies'}
                      {costLabel == null ? '' : ` · ${costLabel}`}
                    </span>
                    <button
                      className="btn primary"
                      disabled={submitting || running || allCommitted}
                      onClick={submit}
                      type="button"
                    >
                      {submitting
                        ? 'Submitting…'
                        : allCommitted
                          ? 'Submitted ✓'
                          : resumable == null
                            ? `Submit ${results.length.toLocaleString()} piece${results.length === 1 ? '' : 's'}`
                            : 'Resume submit'}
                    </button>
                    {resumable != null && !submitting && (
                      <button className="btn small" onClick={discardSubmit} type="button">
                        Discard previous submit
                      </button>
                    )}
                  </div>
                  {resumable != null && !submitting && !allCommitted && (
                    <p className="gate-note">
                      A previous submit for these pieces is saved. Resume continues it without re-signing or
                      re-submitting anything. Discard only forgets local progress; commits already submitted stay on
                      chain.
                    </p>
                  )}
                  {submitState != null && !submitState.persisted && (
                    <p className="pay-setup">
                      This browser is blocking storage, so progress cannot survive a reload. Keep this tab open until
                      every copy reads committed.
                    </p>
                  )}
                  {submitting && submitState?.persisted !== false && (
                    <p className="gate-note">
                      Providers pull and confirm on their own. Closing this tab only pauses new submissions. Progress is
                      saved, and Resume continues exactly where it stopped.
                    </p>
                  )}
                  {submittable.heldBack.length > 0 && (
                    <p className="gate-note">
                      {submittable.heldBack.length.toLocaleString()} piece
                      {submittable.heldBack.length === 1 ? '' : 's'} held back from submit: their gateway CAR was
                      incomplete during prepare (blocks recovered one by one), and the provider pulls that same CAR URL.
                      Retry those rows; they join the submit once the stream comes back complete.
                    </p>
                  )}
                  {submitError != null && (
                    <p className="err-text" title={submitError}>
                      {short(submitError, 120, 0)}
                      {submitBlocked === 'session-margin' && (
                        <>
                          {' '}
                          <button className="btn small" disabled={sessionBusy != null} onClick={extend} type="button">
                            Extend session +24h
                          </button>
                        </>
                      )}
                    </p>
                  )}
                  {allCommitted && !submitting && (
                    <p className="gate-note">
                      Every copy is committed. Revoke the signing session above once you are done migrating.
                    </p>
                  )}
                </>
              ) : (
                <p className="gate-note">
                  Submitting needs the wallet step: a connected wallet on {NETWORKS[targetNetwork].label}, the one-time
                  payment setup, and signing enabled.{' '}
                  <button className="btn small" onClick={() => setPeek('wallet')} type="button">
                    Open the wallet step
                  </button>
                </p>
              )}
              {submitState != null && submitState.contexts.length > 0 && (
                <div className="table">
                  <div className="trow thead submit-row">
                    <span>Copy</span>
                    <span>Provider</span>
                    <span>Status</span>
                    <span>Data set</span>
                  </div>
                  {submitState.contexts.map((c) => (
                    <div className="trow submit-row" key={c.providerId}>
                      <span className="dim" data-label="Copy">
                        {c.role}
                      </span>
                      <span className="mono dim" data-label="Provider" title={c.serviceURL}>
                        {c.providerName || `#${c.providerId}`}
                      </span>
                      {c.phase === 'failed' ? (
                        <span className="err-text" data-label="Status" title={c.error}>
                          {short(c.error ?? 'failed', 36, 0)}
                        </span>
                      ) : (
                        <span className={c.phase === 'done' ? 'ok-text' : 'working'} data-label="Status">
                          {describeSubmitPhase(c)}
                          {submitEtaFor(c)}
                        </span>
                      )}
                      <span className="mono dim" data-label="Data set">
                        {(() => {
                          const txHash = [...c.chunks].reverse().find((ch) => ch.txHash != null)?.txHash
                          return c.dataSetId == null
                            ? txHash == null
                              ? '—'
                              : short(txHash, 10, 4)
                            : `#${c.dataSetId} · ${c.pieceIds?.length ?? 0} piece${c.pieceIds?.length === 1 ? '' : 's'}`
                        })()}
                        {c.dataSetId != null && (
                          <>
                            {' '}
                            <button
                              className="btn small"
                              disabled={submitting || verifying != null}
                              onClick={() => void verifyContext(c.providerId)}
                              type="button"
                            >
                              {verifying === c.providerId ? 'Verifying…' : 'Verify on chain'}
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {verifyError != null && <p className="err-text">{verifyError}</p>}
              {submitState?.contexts.map((c) => {
                const report = verifyReports[c.providerId]
                if (report == null) return null
                const { result, network, dataSetId, cleared } = report
                const h = result.health
                return (
                  <div className="gate-note" key={`verify-${c.providerId}`}>
                    <p>
                      <a href={explorerDataSetUrl(network, dataSetId)} rel="noreferrer" target="_blank">
                        Data set #{dataSetId}
                      </a>{' '}
                      on {network}, read from the chain just now: {h.live ? 'live' : 'DELETED'},{' '}
                      {h.activePieceCount.toString()} active piece{h.activePieceCount === 1n ? '' : 's'} ·{' '}
                      {result.found.size} of {result.found.size + result.missing.length} pieces from this run are on it.
                      {cleared > 0 && (
                        <>
                          {' '}
                          {cleared} previously-skipped piece{cleared === 1 ? ' is' : 's are'} actually committed, so the
                          skipped state is cleared.
                        </>
                      )}
                    </p>
                    <p>
                      {h.lastProvenEpoch == null
                        ? 'The provider has not yet submitted a proof of possession for this data set.'
                        : h.provenSinceAdd
                          ? `Possession proven: the provider's last accepted proof (epoch ${h.lastProvenEpoch}) covers everything this run added.`
                          : `The provider has proven possession (epoch ${h.lastProvenEpoch}), but not yet since this run's last add. The next proof will cover it.`}{' '}
                      {h.inGoodStanding ? 'Proving deadline not missed.' : 'The next proving deadline has passed.'}
                    </p>
                    {result.missing.length > 0 && (
                      <>
                        <p>
                          {result.missing.length} piece{result.missing.length === 1 ? '' : 's'} from this run{' '}
                          {result.missing.length === 1 ? 'is' : 'are'} not on the data set under{' '}
                          {result.missing.length === 1 ? 'its' : 'their'} own PieceCID. A piece migrated through the
                          local packing path lives on chain under the packed piece's CID instead, which this page cannot
                          match up. <code>ipfs2foc report</code> on the local database reconciles those.
                        </p>
                        <ul className="mono">
                          {result.missing.slice(0, 8).map((p) => (
                            <li key={p}>
                              <a href={explorerPieceUrl(network, p)} rel="noreferrer" target="_blank">
                                {short(p, 16, 8)}
                              </a>
                            </li>
                          ))}
                          {result.missing.length > 8 && <li>… and {result.missing.length - 8} more</li>}
                        </ul>
                      </>
                    )}
                    {result.unrecognized.length > 0 && (
                      <p>
                        The data set also holds {result.unrecognized.length} piece
                        {result.unrecognized.length === 1 ? '' : 's'} this run did not prepare. Those are typically
                        packed pieces committed from the local console against the same data set.
                      </p>
                    )}
                  </div>
                )
              })}
              {deferredCids.length > 0 && !submitting && (
                <div className="gate-note">
                  <p>
                    {deferredCids.length} piece{deferredCids.length === 1 ? ' was' : 's were'} skipped: the provider
                    could not fetch them from their source after retries (the "check availability" links above show
                    why). Everything else committed. If the source recovers, or you host the bytes another way, retry
                    here; otherwise the remainder manifest carries them to the{' '}
                    <a
                      href="https://github.com/FilOzone/ipfs2foc/blob/main/docs/local-console.md"
                      rel="noreferrer"
                      target="_blank"
                    >
                      local path
                    </a>
                    . If any of these were already stored in this data set (an earlier run, another tool), click Verify
                    on chain in the provider row above: anything the chain already holds is removed from this list.
                  </p>
                  <div className="actions">
                    {session != null && (
                      <button className="btn small" onClick={() => void retryDeferred()} type="button">
                        Retry the skipped piece{deferredCids.length === 1 ? '' : 's'}
                      </button>
                    )}
                    {results.length > 0 && (
                      <button className="btn small" onClick={saveDeferredManifest} type="button">
                        Download manifest of the skipped piece{deferredCids.length === 1 ? '' : 's'}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      </div>

      <footer className="foot">
        <span>
          Every commitment is computed in this tab from blocks it hash-checks itself, so a gateway cannot hand you the
          wrong bytes without the run failing.
        </span>
        <a href="https://github.com/FilOzone/ipfs2foc" rel="noreferrer" target="_blank">
          FilOzone/ipfs2foc
        </a>
        <ContactLink>Different requirements? Talk to us</ContactLink>
      </footer>
    </div>
  )
}
