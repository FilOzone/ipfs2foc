// Module worker: runs one computePiece (fetch + CAR parse + WASM commP hash)
// off the main thread. One worker per in-flight CID, so concurrent CIDs hash on
// separate cores instead of time-slicing the UI thread — with the JS hasher on
// the main thread, four concurrent rows shared one core and each crawled.
import { computePiece } from './commp.ts'

// Progress is throttled here, not just in the UI: every postMessage crosses a
// thread boundary and a stream at hash speed would emit thousands per second.
const PROGRESS_INTERVAL_MS = 200

export interface WorkerRequest {
  gateway: string
  cid: string
  relayBase: string
}

export type WorkerResponse =
  | { type: 'progress'; bytes: number }
  | { type: 'done'; result: Awaited<ReturnType<typeof computePiece>> }
  | { type: 'error'; message: string }

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { gateway, cid, relayBase } = e.data
  const post = (msg: WorkerResponse) => self.postMessage(msg)
  let lastEmit = 0
  try {
    const result = await computePiece(gateway, cid, relayBase, (bytes) => {
      const now = performance.now()
      if (now - lastEmit < PROGRESS_INTERVAL_MS) return
      lastEmit = now
      post({ type: 'progress', bytes })
    })
    post({ type: 'done', result })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
