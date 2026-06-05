// Pool of long-lived hash workers (hash-worker.ts), one in-flight job per
// worker. Pieces hash on separate cores while retrieval and CAR assembly stay
// on the main thread with the shared helia node.
//
// Backpressure is the protocol itself: write() resolves when the worker has
// hashed the chunk, so the canonical export can never run ahead of hashing by
// more than one chunk per piece.

export type HashWorkerRequest =
  | { type: 'begin' }
  | { type: 'chunk'; buf: ArrayBuffer }
  | { type: 'finish' }

export type HashWorkerResponse =
  | { type: 'ready' }
  | { type: 'ack' }
  | { type: 'digest'; multihash: ArrayBuffer }
  | { type: 'error'; message: string }

/**
 * Matches the prepare concurrency in app.tsx — one hashing core per
 * concurrently processed CID.
 */
export const HASH_POOL_SIZE = 4

export interface HashJob {
  /** Hash a chunk; resolves when the worker has consumed it. */
  write(chunk: Uint8Array): Promise<void>
  /** Finalize: returns the multihash bytes and returns the worker to the pool. */
  finish(): Promise<Uint8Array>
  /** Abandon the job; the worker is replaced, never reused mid-state. */
  cancel(): void
}

class PooledWorker {
  worker: Worker
  private pending: { resolve(msg: HashWorkerResponse): void; reject(err: Error): void } | null = null

  constructor() {
    this.worker = new Worker(new URL('./hash-worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<HashWorkerResponse>) => {
      const pending = this.pending
      this.pending = null
      pending?.resolve(e.data)
    }
    this.worker.onerror = (e) => {
      const pending = this.pending
      this.pending = null
      pending?.reject(new Error(e.message || 'hash worker failed to start'))
    }
  }

  async request(msg: HashWorkerRequest, transfer?: Transferable[]): Promise<HashWorkerResponse> {
    const reply = new Promise<HashWorkerResponse>((resolve, reject) => {
      this.pending = { resolve, reject }
    })
    this.worker.postMessage(msg, { transfer: transfer ?? [] })
    const res = await reply
    if (res.type === 'error') throw new Error(res.message)
    return res
  }
}

const idle: PooledWorker[] = []
let liveWorkers = 0
const waiters: Array<(w: PooledWorker) => void> = []

async function acquire(): Promise<PooledWorker> {
  const existing = idle.pop()
  if (existing != null) return existing
  if (liveWorkers < HASH_POOL_SIZE) {
    liveWorkers++
    return new PooledWorker()
  }
  return new Promise((resolve) => {
    waiters.push(resolve)
  })
}

function release(w: PooledWorker, broken: boolean): void {
  if (broken) {
    w.worker.terminate()
    liveWorkers--
    // A waiter is owed a worker; spawn a fresh one in place of the broken one.
    if (waiters.length > 0) {
      liveWorkers++
      const next = waiters.shift() as (w: PooledWorker) => void
      next(new PooledWorker())
    }
    return
  }
  const next = waiters.shift()
  if (next != null) next(w)
  else idle.push(w)
}

/**
 * Acquire a worker and start a hash job on it. Chunks are transferred (or
 * copied when the view does not own its buffer) rather than cloned.
 */
export async function beginHash(): Promise<HashJob> {
  const w = await acquire()
  let settled = false
  try {
    await w.request({ type: 'begin' })
  } catch (err) {
    release(w, true)
    throw err
  }
  return {
    async write(chunk: Uint8Array): Promise<void> {
      // Copy, then transfer the copy. Transferring the chunk's own buffer
      // detaches it on this thread, and the canonical exporter's output
      // chunks alias the block bytes its traversal still has to decode links
      // from — detaching them ends every walk at the root (caught by the
      // pinned-PieceCID browser check: multi-block DAGs truncated to one
      // block). One memcpy per chunk is noise next to the WASM hashing.
      const buf = chunk.slice().buffer as ArrayBuffer
      try {
        await w.request({ type: 'chunk', buf }, [buf])
      } catch (err) {
        if (!settled) {
          settled = true
          release(w, true)
        }
        throw err
      }
    },
    async finish(): Promise<Uint8Array> {
      try {
        const res = await w.request({ type: 'finish' })
        if (res.type !== 'digest') throw new Error(`unexpected hash worker reply: ${res.type}`)
        settled = true
        release(w, false)
        return new Uint8Array(res.multihash)
      } catch (err) {
        if (!settled) {
          settled = true
          release(w, true)
        }
        throw err
      }
    },
    cancel(): void {
      if (settled) return
      settled = true
      release(w, true)
    },
  }
}
