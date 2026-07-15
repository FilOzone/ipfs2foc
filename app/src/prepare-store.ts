// Row state for the prepare run, held outside React (#57). The console takes
// CID lists in the millions; one state object per CID in a useState array
// froze the tab at 100k (half a million DOM nodes, 5.7s click latency). This
// store keeps the input list as the one array it already is, tracks only the
// rows that have left the queued state, and hands the component counts and a
// paged slice — so render cost follows the page size, not the run size.
//
// done is implicit: a CID with a stored result and no live state is done, a
// CID with neither is queued. The live map holds only working and failed
// rows, which stay bounded by the worker pool and the failure count.
import type { PieceResult } from './commp.ts'

export type RowState =
  | { phase: 'queued' }
  | { phase: 'working'; bytes: number; rate: number }
  | { phase: 'done'; result: PieceResult }
  | { phase: 'error'; message: string; detail: string }

export type RowFilter = 'all' | 'queued' | 'working' | 'done' | 'error'

// Progress ticks arrive from every worker; repainting per tick starves the
// hashing thread. Subscribers hear about mutations at most this often.
const NOTIFY_MS = 200

const QUEUED: RowState = { phase: 'queued' }

export interface RunCounts {
  total: number
  queued: number
  working: number
  done: number
  error: number
}

export interface PrepareStore {
  subscribe(listener: () => void): () => void
  getVersion(): number
  /** Set the run's input order: prune results to it, reset live rows. */
  setCids(cids: string[]): void
  clear(): void
  markWorking(cid: string, bytes: number, rate: number): void
  markDone(cid: string, result: PieceResult): void
  markError(cid: string, message: string, detail: string): void
  /** Record a restored result without touching a live row (merge, never replace). */
  seedResult(cid: string, result: PieceResult): void
  hasResult(cid: string): boolean
  getState(cid: string): RowState
  counts(): RunCounts
  /** CIDs matching a state filter — cached, rebuilt only when membership changed. */
  listFor(filter: RowFilter): string[]
  /** Completed pieces in input order (rows currently shown as done). */
  resultsList(): PieceResult[]
  /** Every stored result keyed by input CID — the shape saveRun persists. */
  resultsRecord(): Record<string, PieceResult>
  /** The most recently completed piece, for the worked example. */
  lastDone(): PieceResult | null
}

export function createPrepareStore(): PrepareStore {
  let cids: string[] = []
  let cidSet = new Set<string>()
  const results = new Map<string, PieceResult>()
  const live = new Map<string, RowState>()
  const errorCids = new Set<string>()
  const workingCids = new Set<string>()
  let doneCount = 0
  let last: PieceResult | null = null

  let version = 0
  // Membership epochs per state. Progress ticks bump only the version, so a
  // filtered list is rebuilt when a row entered or left it — not per byte.
  const epochs = { queued: 0, working: 0, done: 0, error: 0 }
  const listCaches = new Map<RowFilter, { epoch: number; list: string[] }>()
  let resultsCache: { epoch: number; list: PieceResult[] } | null = null
  let recordCache: { epoch: number; record: Record<string, PieceResult> } | null = null

  const listeners = new Set<() => void>()
  let notifyPending = false
  function bump(): void {
    version++
    if (notifyPending) return
    notifyPending = true
    setTimeout(() => {
      notifyPending = false
      for (const l of listeners) l()
    }, NOTIFY_MS)
  }

  function dropLive(cid: string): RowState | undefined {
    const prev = live.get(cid)
    if (prev == null) {
      epochs.queued++
      return prev
    }
    live.delete(cid)
    if (prev.phase === 'working') {
      workingCids.delete(cid)
      epochs.working++
    } else if (prev.phase === 'error') {
      errorCids.delete(cid)
      epochs.error++
    }
    return prev
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getVersion: () => version,

    setCids(next) {
      cids = next
      cidSet = new Set(next)
      for (const key of results.keys()) if (!cidSet.has(key)) results.delete(key)
      live.clear()
      errorCids.clear()
      workingCids.clear()
      doneCount = 0
      last = null
      for (const cid of cids) {
        const r = results.get(cid)
        if (r != null) {
          doneCount++
          last = r
        }
      }
      epochs.queued++
      epochs.working++
      epochs.done++
      epochs.error++
      bump()
    },

    clear() {
      cids = []
      cidSet = new Set()
      results.clear()
      live.clear()
      errorCids.clear()
      workingCids.clear()
      doneCount = 0
      last = null
      epochs.queued++
      epochs.working++
      epochs.done++
      epochs.error++
      bump()
    },

    markWorking(cid, bytes, rate) {
      const prev = live.get(cid)
      if (prev == null || prev.phase !== 'working') {
        dropLive(cid)
        workingCids.add(cid)
        epochs.working++
      }
      live.set(cid, { phase: 'working', bytes, rate })
      bump()
    },

    markDone(cid, result) {
      dropLive(cid)
      if (!results.has(cid) && cidSet.has(cid)) doneCount++
      results.set(cid, result)
      last = result
      epochs.done++
      bump()
    },

    markError(cid, message, detail) {
      const prev = dropLive(cid)
      if (prev?.phase !== 'error') {
        errorCids.add(cid)
        epochs.error++
      }
      live.set(cid, { phase: 'error', message, detail })
      bump()
    },

    seedResult(cid, result) {
      if (results.has(cid)) return
      results.set(cid, result)
      if (cidSet.has(cid)) {
        doneCount++
        epochs.done++
        epochs.queued++
        bump()
      }
    },

    hasResult: (cid) => results.has(cid),

    getState(cid) {
      const liveState = live.get(cid)
      if (liveState != null) return liveState
      const result = results.get(cid)
      if (result != null) return { phase: 'done', result }
      return QUEUED
    },

    counts() {
      const total = cids.length
      const working = workingCids.size
      const error = errorCids.size
      return {
        total,
        working,
        error,
        done: doneCount,
        queued: Math.max(0, total - doneCount - working - error),
      }
    },

    listFor(filter) {
      if (filter === 'all') return cids
      // done and queued are defined by exclusion, so their membership can
      // change on any transition — key those caches on every epoch.
      const epoch =
        filter === 'working'
          ? epochs.working
          : filter === 'error'
            ? epochs.error
            : epochs.queued + epochs.working + epochs.done + epochs.error
      const cached = listCaches.get(filter)
      if (cached != null && cached.epoch === epoch) return cached.list
      const list =
        filter === 'working'
          ? [...workingCids]
          : filter === 'error'
            ? [...errorCids]
            : filter === 'done'
              ? cids.filter((cid) => results.has(cid) && !live.has(cid))
              : cids.filter((cid) => !results.has(cid) && !live.has(cid))
      listCaches.set(filter, { epoch, list })
      return list
    },

    resultsList() {
      const epoch = epochs.done + epochs.working + epochs.error
      if (resultsCache != null && resultsCache.epoch === epoch) return resultsCache.list
      const list: PieceResult[] = []
      for (const cid of cids) {
        if (live.has(cid)) continue
        const r = results.get(cid)
        if (r != null) list.push(r)
      }
      resultsCache = { epoch, list }
      return list
    },

    resultsRecord() {
      if (recordCache != null && recordCache.epoch === epochs.done) return recordCache.record
      recordCache = { epoch: epochs.done, record: Object.fromEntries(results) }
      return recordCache.record
    },

    lastDone: () => last,
  }
}
