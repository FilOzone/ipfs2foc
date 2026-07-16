/**
 * `ipfs2foc-core/car-stream-source` teardown: the gateway helpers must
 * release their HTTP resources deterministically. An abandoned response body
 * holds its HTTP/2 stream (and its share of the connection flow-control
 * window) until the browser gets around to it; at prepare concurrency that
 * accumulates into every stream on the connection going silent at once. The
 * spec-clean release is an explicit `body.cancel()`, so these tests pin it:
 *
 * - a non-OK response's body is cancelled before `fetchOk` throws
 * - a consumer that stops the CAR stream early cancels the response body
 * - a retry backoff sleep aborts promptly instead of running out its timer
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CarWriter } from '@ipld/car'
import { fetchGatewayRawBlock, openGatewayCarStream } from 'ipfs2foc-core/car-stream-source'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'

const RAW_CODE = 0x55

async function rawCid(bytes: Uint8Array): Promise<CID> {
  return CID.createV1(RAW_CODE, await sha256.digest(bytes))
}

/** A tiny valid CAR (header + one raw block) as bytes. */
async function tinyCar(): Promise<{ car: Uint8Array; root: CID }> {
  const bytes = new TextEncoder().encode('teardown probe block')
  const root = await rawCid(bytes)
  const { writer, out } = CarWriter.create([root as never])
  const chunks: Uint8Array[] = []
  const collected = (async () => {
    for await (const c of out) chunks.push(c)
  })()
  await writer.put({ cid: root as never, bytes })
  await writer.close()
  await collected
  const car = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let off = 0
  for (const c of chunks) {
    car.set(c, off)
    off += c.length
  }
  return { car, root }
}

/** Serve one canned response; report whether its body got cancelled. */
function stubFetch(status: number, body: () => ReadableStream<Uint8Array>) {
  const original = globalThis.fetch
  const state = { cancelled: false, calls: 0 }
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    state.calls++
    init?.signal?.throwIfAborted()
    const stream = body()
    const wrapped = new ReadableStream<Uint8Array>({
      start(controller) {
        const reader = stream.getReader()
        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) {
                controller.close()
                return
              }
              controller.enqueue(value)
            }
          } catch {
            // underlying stream torn down
          }
        }
        void pump()
      },
      cancel() {
        state.cancelled = true
      },
    })
    return new Response(status === 204 ? null : wrapped, { status })
  }) as typeof fetch
  return { state, restore: () => (globalThis.fetch = original) }
}

const never = () =>
  new ReadableStream<Uint8Array>({
    start() {
      // stays open; only cancel() ends it
    },
  })

test('fetchGatewayRawBlock cancels the error body before throwing', async () => {
  const { state, restore } = stubFetch(404, never)
  try {
    const cid = await rawCid(new TextEncoder().encode('x'))
    await assert.rejects(
      fetchGatewayRawBlock('https://gw.example', cid),
      (err: Error) => /received 404/.test(err.message)
    )
    assert.equal(state.cancelled, true, 'the 404 body must be cancelled, not abandoned')
  } finally {
    restore()
  }
})

test('openGatewayCarStream cancels the body when the consumer stops early', async () => {
  const { car, root } = await tinyCar()
  const { state, restore } = stubFetch(
    200,
    () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(car)
          // never closes: simulates a stream with more data on the wire
        },
      })
  )
  try {
    const iter = openGatewayCarStream('https://gw.example', root)[Symbol.asyncIterator]()
    const first = await iter.next()
    assert.equal(first.done, false)
    assert.equal(first.value.cid.toString(), root.toString())
    await iter.return?.(undefined)
    assert.equal(state.cancelled, true, 'stopping the consumer must cancel the response body')
  } finally {
    restore()
  }
})

test('a retry backoff aborts promptly instead of sleeping it out', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    throw new TypeError('fetch failed')
  }) as typeof fetch
  try {
    const cid = await rawCid(new TextEncoder().encode('y'))
    const ctrl = new AbortController()
    const t0 = performance.now()
    const done = assert.rejects(fetchGatewayRawBlock('https://gw.example', cid, ctrl.signal))
    setTimeout(() => ctrl.abort(new Error('piece cancelled')), 50)
    await done
    const elapsed = performance.now() - t0
    assert.ok(calls >= 1)
    assert.ok(elapsed < 500, `rejected in ${elapsed.toFixed(0)}ms; the 1s backoff must not run out`)
  } finally {
    globalThis.fetch = original
  }
})
