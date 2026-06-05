// Pure piece-hash worker: the WASM fr32 hasher behind a chunk protocol.
//
// Retrieval and CAR assembly run on the main thread — the helia node must
// live there (WebRTC transports do not exist in workers, and node state
// should outlive any one piece) — so the worker's job is only the CPU-bound
// hashing. One job at a time per worker; the client serializes the protocol
// by awaiting each reply before posting the next message.
//
// The hasher module is loaded with a dynamic import, deliberately: it
// initializes its WASM with top-level await, and Chromium enables a module
// worker's message port at the first top-level-await suspension — a message
// posted before evaluation finishes is dropped, not queued. With the dynamic
// import this module evaluates synchronously, onmessage is registered before
// the port is enabled, and the first request awaits the module promise.
import type { HashWorkerRequest, HashWorkerResponse } from './hash-pool.ts'

const hasherModule = import('fr32-sha2-256-trunc254-padded-binary-tree-multihash')

type Hasher = Awaited<typeof hasherModule> extends { create(): infer H } ? H : never

// WASM hasher memory lives outside the JS heap — freed on finish and on error.
let hasher: Hasher | null = null

self.onmessage = async (e: MessageEvent<HashWorkerRequest>) => {
  const msg = e.data
  try {
    if (msg.type === 'begin') {
      const { create } = await hasherModule
      hasher?.free()
      hasher = create() as Hasher
      self.postMessage({ type: 'ready' } satisfies HashWorkerResponse)
    } else if (msg.type === 'chunk') {
      if (hasher == null) throw new Error('chunk before begin')
      hasher.write(new Uint8Array(msg.buf))
      self.postMessage({ type: 'ack' } satisfies HashWorkerResponse)
    } else {
      if (hasher == null) throw new Error('finish before begin')
      const out = new Uint8Array(hasher.multihashByteLength())
      hasher.digestInto(out, 0, true)
      hasher.free()
      hasher = null
      self.postMessage({ type: 'digest', multihash: out.buffer } satisfies HashWorkerResponse, {
        transfer: [out.buffer],
      })
    }
  } catch (err) {
    try {
      hasher?.free()
    } catch {
      // already freed
    }
    hasher = null
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies HashWorkerResponse)
  }
}
