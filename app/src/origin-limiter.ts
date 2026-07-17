// Per-origin scheduling for prepare retrieval (#59 follow-up). The global
// pool bounds total in-flight pieces; every CAR stream to one origin rides
// the same HTTP/2 connection, and a saturated or throttled connection stalls
// every stream on it at the same instant. Two controls, both scoped per
// origin:
//
// - a slot cap: at most `cap` concurrent holds, extra acquirers queue FIFO.
//   The race's own stagger turns a long queue into spillover — a root whose
//   preferred origin is full drifts to the next tier when its offset expires.
// - a stall breaker: `stallTrip` consecutive stall reports with no progress
//   in between mark the origin unhealthy for `coolMs`, so new roots skip
//   straight to their next source instead of joining a wedged connection.
//
// Verification is unaffected by any of this: it only decides where a request
// goes, never what is accepted — every block stays hash-verified.

interface Waiter {
  resolve: (release: () => void) => void
  reject: (err: unknown) => void
  signal?: AbortSignal
}

interface OriginState {
  held: number
  queue: Waiter[]
  stallStreak: number
  coolingUntil: number
}

export interface OriginLimiterOptions {
  /** Concurrent CAR streams allowed per origin. */
  cap?: number
  /** Consecutive stalls (no progress between them) that trip the breaker. */
  stallTrip?: number
  /** How long a tripped origin stays demoted. */
  coolMs?: number
}

export interface OriginLimiter {
  /**
   * Hold a slot on `origin`; resolves with the release function. Queued FIFO
   * when the origin is at cap; rejects (and leaves the queue) if `signal`
   * aborts first. Release is idempotent.
   */
  acquire(origin: string, signal?: AbortSignal): Promise<() => void>
  /** False while the origin's stall breaker is cooling down. */
  healthy(origin: string): boolean
  /** Report bytes advancing on this origin (resets its stall streak). */
  noteProgress(origin: string): void
  /** Report a stalled piece attributed to this origin. */
  noteStall(origin: string): void
}

const DEFAULT_CAP = 16
const DEFAULT_STALL_TRIP = 3
const DEFAULT_COOL_MS = 30_000

export function createOriginLimiter(opts: OriginLimiterOptions = {}): OriginLimiter {
  const cap = opts.cap ?? DEFAULT_CAP
  const stallTrip = opts.stallTrip ?? DEFAULT_STALL_TRIP
  const coolMs = opts.coolMs ?? DEFAULT_COOL_MS
  const origins = new Map<string, OriginState>()

  const stateOf = (origin: string): OriginState => {
    let s = origins.get(origin)
    if (s == null) {
      s = { held: 0, queue: [], stallStreak: 0, coolingUntil: 0 }
      origins.set(origin, s)
    }
    return s
  }

  const makeRelease = (s: OriginState): (() => void) => {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = s.queue.shift()
      if (next == null) {
        s.held--
      } else {
        // Hand the slot over directly; `held` stays constant.
        next.resolve(makeRelease(s))
      }
    }
  }

  return {
    acquire(origin, signal) {
      const s = stateOf(origin)
      if (signal?.aborted === true) {
        return Promise.reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
      }
      if (s.held < cap) {
        s.held++
        return Promise.resolve(makeRelease(s))
      }
      return new Promise<() => void>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, signal }
        if (signal != null) {
          const onAbort = () => {
            const i = s.queue.indexOf(waiter)
            if (i !== -1) s.queue.splice(i, 1)
            reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
          }
          signal.addEventListener('abort', onAbort, { once: true })
          waiter.resolve = (release) => {
            signal.removeEventListener('abort', onAbort)
            resolve(release)
          }
        }
        s.queue.push(waiter)
      })
    },
    healthy(origin) {
      const s = origins.get(origin)
      if (s == null) return true
      return performance.now() >= s.coolingUntil
    },
    noteProgress(origin) {
      const s = origins.get(origin)
      if (s != null) s.stallStreak = 0
    },
    noteStall(origin) {
      const s = stateOf(origin)
      s.stallStreak++
      if (s.stallStreak >= stallTrip) {
        s.coolingUntil = performance.now() + coolMs
        s.stallStreak = 0
      }
    },
  }
}

/** The app-wide limiter the prepare pipeline shares. */
export const originLimiter = createOriginLimiter()
