// Main-thread client for commp.worker.ts: same signature as computePiece, but
// the fetch/parse/hash runs in a dedicated worker. The worker is created per
// call and terminated when the promise settles — spawn cost is negligible next
// to a CAR download, and terminating leaks nothing if a stream hangs.
import type { PieceResult } from './commp.ts'
import type { WorkerRequest, WorkerResponse } from './commp.worker.ts'

export function computePieceInWorker(
  gateway: string,
  cid: string,
  relayBase: string,
  onProgress?: (bytes: number) => void
): Promise<PieceResult> {
  return new Promise<PieceResult>((resolve, reject) => {
    const worker = new Worker(new URL('./commp.worker.ts', import.meta.url), { type: 'module' })
    const finish = (fn: () => void) => {
      worker.terminate()
      fn()
    }
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.type === 'progress') onProgress?.(msg.bytes)
      else if (msg.type === 'done') finish(() => resolve(msg.result))
      else finish(() => reject(new Error(msg.message)))
    }
    worker.onerror = (e) => finish(() => reject(new Error(e.message || 'worker failed to start')))
    worker.postMessage({ gateway, cid, relayBase } satisfies WorkerRequest)
  })
}
