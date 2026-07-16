/**
 * Per-origin scheduling for prepare retrieval. The global pool bounds total
 * in-flight pieces; this bounds how many CAR streams ride one origin's
 * HTTP/2 connection at once (a saturated connection stalls every stream on
 * it together), and stops assigning new streams to an origin that keeps
 * stalling until it has cooled down.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOriginLimiter } from '../src/origin-limiter.ts'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

test('cap: the third stream on one origin waits for a release', async () => {
  const limiter = createOriginLimiter({ cap: 2 })
  const r1 = await limiter.acquire('https://a.example')
  const r2 = await limiter.acquire('https://a.example')
  let third = false
  const p3 = limiter.acquire('https://a.example').then((r) => {
    third = true
    return r
  })
  // A different origin is not affected by a full one.
  const other = await limiter.acquire('https://b.example')
  other()
  await tick()
  assert.equal(third, false, 'third acquire must queue while the cap is held')
  r1()
  const r3 = await p3
  assert.equal(third, true)
  r2()
  r3()
})

test('cap: releasing twice frees only one slot', async () => {
  const limiter = createOriginLimiter({ cap: 1 })
  const r1 = await limiter.acquire('https://a.example')
  r1()
  r1()
  const r2 = await limiter.acquire('https://a.example')
  let third = false
  void limiter.acquire('https://a.example').then(() => {
    third = true
  })
  await tick()
  assert.equal(third, false, 'double release must not mint an extra slot')
  r2()
  await tick()
  assert.equal(third, true)
})

test('abort: a queued waiter leaves the queue when its signal fires', async () => {
  const limiter = createOriginLimiter({ cap: 1 })
  const r1 = await limiter.acquire('https://a.example')
  const ctrl = new AbortController()
  const rejected = assert.rejects(limiter.acquire('https://a.example', ctrl.signal))
  ctrl.abort(new Error('piece cancelled'))
  await rejected
  // The abandoned queue spot must not consume the next release.
  let second = false
  void limiter.acquire('https://a.example').then((r) => {
    second = true
    r()
  })
  r1()
  await tick()
  assert.equal(second, true, 'the released slot must go to the live waiter')
})

test('breaker: consecutive stalls trip an origin; progress resets the count', async () => {
  const limiter = createOriginLimiter({ cap: 4, stallTrip: 3, coolMs: 50 })
  const origin = 'https://a.example'
  assert.equal(limiter.healthy(origin), true)
  limiter.noteStall(origin)
  limiter.noteStall(origin)
  limiter.noteProgress(origin)
  limiter.noteStall(origin)
  limiter.noteStall(origin)
  assert.equal(limiter.healthy(origin), true, 'progress must reset the stall streak')
  limiter.noteStall(origin)
  assert.equal(limiter.healthy(origin), false, 'third consecutive stall trips the breaker')
  // Other origins are unaffected.
  assert.equal(limiter.healthy('https://b.example'), true)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(limiter.healthy(origin), true, 'the breaker resets after the cooldown')
})
