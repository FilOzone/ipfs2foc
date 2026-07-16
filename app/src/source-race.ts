// Hedged racing across a root's retrieval sources (#59). Every source can
// serve the same verified blocks, so the fastest one should — but starting
// them all at once spends every host's bandwidth on work one of them will
// win. Each candidate instead gets a start offset: the preferred source
// leads, and later tiers join only if nothing has produced a block yet (or
// everything ahead of them already failed, which starts the next tier
// immediately). The moment one candidate yields its first block it wins and
// the rest are aborted.
//
// Losing early costs a request that gets torn down; hosts behind the later
// offsets — the free community gateway in particular — see traffic only for
// the roots the preferred sources are slow or dead on.

/** Resolves after ms, rejecting immediately if the signal aborts first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface StreamCandidate<B> {
  /** Start producing blocks. Must stop when the signal aborts. */
  start(signal: AbortSignal): AsyncIterable<B>
  /** Head start the earlier tiers get before this source spends a request. */
  delayMs: number
  /** Called if this candidate wins — produced the stream's first block. */
  onWin?(): void
}

const TICK = Symbol('race-tick')

/**
 * Yield blocks from whichever candidate produces one first. Candidates start
 * at their delay offsets (or sooner, when everything already running has
 * failed); the first to yield becomes the stream and every other candidate
 * is aborted. Throws an AggregateError of every failure when no candidate
 * produces a block.
 */
export async function* raceBlockStreams<B>(
  candidates: Array<StreamCandidate<B>>,
  signal?: AbortSignal
): AsyncIterable<B> {
  if (candidates.length === 0) throw new Error('no sources to race')
  interface Entry {
    ctrl: AbortController
    iter: AsyncIterator<B>
    onWin?(): void
  }
  type FirstBlock = { entry: Entry; res?: IteratorResult<B>; err?: unknown }
  const t0 = performance.now()
  const waiting = [...candidates].sort((a, b) => a.delayMs - b.delayMs)
  const started: Entry[] = []
  const pendingFirst = new Map<Entry, Promise<FirstBlock>>()
  const errors: unknown[] = []

  const startNext = () => {
    const c = waiting.shift()
    if (c == null) return
    const ctrl = new AbortController()
    if (signal != null) {
      if (signal.aborted) ctrl.abort(signal.reason)
      else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true, signal: ctrl.signal })
    }
    const entry: Entry = { ctrl, iter: c.start(ctrl.signal)[Symbol.asyncIterator](), onWin: c.onWin }
    started.push(entry)
    pendingFirst.set(
      entry,
      entry.iter.next().then(
        (res) => ({ entry, res }),
        (err: unknown) => ({ entry, err })
      )
    )
  }

  try {
    while (true) {
      signal?.throwIfAborted()
      const elapsed = performance.now() - t0
      // Start everything due — and if every started candidate has already
      // failed, pull the next tier forward rather than idling out its delay.
      while (waiting.length > 0 && (waiting[0].delayMs <= elapsed || pendingFirst.size === 0)) startNext()
      if (pendingFirst.size === 0) throw new AggregateError(errors, 'every source failed for this root')
      const racers: Array<Promise<FirstBlock | typeof TICK>> = [...pendingFirst.values()]
      if (waiting.length > 0) {
        racers.push(sleep(Math.max(0, waiting[0].delayMs - elapsed), signal).then(() => TICK))
      }
      const outcome = await Promise.race(racers)
      if (outcome === TICK) continue
      pendingFirst.delete(outcome.entry)
      if (outcome.err != null) {
        errors.push(outcome.err)
        outcome.entry.ctrl.abort(new Error('failed before producing a block'))
        continue
      }
      if (outcome.res == null || outcome.res.done === true) {
        errors.push(new Error('source ended without producing a block'))
        continue
      }
      // Winner: everyone else stops spending requests now. Abort reaches a
      // candidate blocked in an await (fetch, read); `return()` closes one
      // suspended at a yield, which abort alone never resumes — that loser
      // would otherwise hold its stream open until collected. Not awaited: a
      // return() queued behind a pending await settles whenever the abort
      // unblocks it, and the race must not wait on that.
      for (const e of started) {
        if (e !== outcome.entry) {
          e.ctrl.abort(new Error('another source answered first'))
          void e.iter.return?.(undefined as never).catch(() => {
            // the candidate already failed; there is nothing to close
          })
        }
      }
      outcome.entry.onWin?.()
      yield outcome.res.value
      while (true) {
        const n = await outcome.entry.iter.next()
        if (n.done === true) return
        yield n.value
      }
    }
  } finally {
    for (const e of started) {
      e.ctrl.abort(new Error('race torn down'))
      void e.iter.return?.(undefined as never).catch(() => {
        // already failed; nothing to close
      })
    }
  }
}

export interface FetchAttempt {
  run(signal: AbortSignal): Promise<Uint8Array>
  delayMs: number
}

/**
 * The single-block version of the race: first fulfilled attempt wins and the
 * rest abort; a failure starts the next tier immediately. Throws an
 * AggregateError when every attempt fails.
 */
export async function hedgeFetch(attempts: FetchAttempt[], signal?: AbortSignal): Promise<Uint8Array> {
  if (attempts.length === 0) throw new Error('no sources to fetch from')
  interface Entry {
    ctrl: AbortController
  }
  type Settled = { entry: Entry; bytes?: Uint8Array; err?: unknown }
  const t0 = performance.now()
  const waiting = [...attempts].sort((a, b) => a.delayMs - b.delayMs)
  const started: Entry[] = []
  const pending = new Map<Entry, Promise<Settled>>()
  const errors: unknown[] = []

  const startNext = () => {
    const a = waiting.shift()
    if (a == null) return
    const ctrl = new AbortController()
    if (signal != null) {
      if (signal.aborted) ctrl.abort(signal.reason)
      else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true, signal: ctrl.signal })
    }
    const entry: Entry = { ctrl }
    started.push(entry)
    pending.set(
      entry,
      a.run(ctrl.signal).then(
        (bytes) => ({ entry, bytes }),
        (err: unknown) => ({ entry, err })
      )
    )
  }

  try {
    while (true) {
      signal?.throwIfAborted()
      const elapsed = performance.now() - t0
      while (waiting.length > 0 && (waiting[0].delayMs <= elapsed || pending.size === 0)) startNext()
      if (pending.size === 0) throw new AggregateError(errors, 'every source failed for this block')
      const racers: Array<Promise<Settled | typeof TICK>> = [...pending.values()]
      if (waiting.length > 0) {
        racers.push(sleep(Math.max(0, waiting[0].delayMs - elapsed), signal).then(() => TICK))
      }
      const outcome = await Promise.race(racers)
      if (outcome === TICK) continue
      pending.delete(outcome.entry)
      if (outcome.bytes != null) {
        for (const e of started) {
          if (e !== outcome.entry) e.ctrl.abort(new Error('another source answered first'))
        }
        return outcome.bytes
      }
      errors.push(outcome.err)
    }
  } finally {
    for (const e of started) e.ctrl.abort(new Error('race torn down'))
  }
}
