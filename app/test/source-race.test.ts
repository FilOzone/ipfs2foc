/**
 * `raceBlockStreams` teardown: a losing candidate's generator must be closed
 * (its `finally` run) when the race picks a winner — not left suspended at a
 * `yield` until garbage collection. A suspended loser holds whatever its
 * generator held open (for the gateway CAR path, an HTTP/2 stream and its
 * flow-control credit), and `AbortController.abort()` alone never resumes a
 * generator that is parked at a yield.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { raceBlockStreams, type StreamCandidate } from '../src/source-race.ts'

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function collect<B>(iter: AsyncIterable<B>): Promise<B[]> {
  const out: B[] = []
  for await (const b of iter) out.push(b)
  return out
}

test('a loser suspended at yield is closed when the winner is picked', async () => {
  let loserClosed = false
  const loser: StreamCandidate<string> = {
    delayMs: 0,
    start: async function* () {
      try {
        // Ignores its abort signal on purpose: models a candidate parked in
        // code the signal does not reach. It loses the race during this wait.
        await wait(20)
        yield 'loser-block'
        await new Promise<never>(() => {
          // never pulled again; without an explicit close this generator
          // would stay suspended at the yield above forever
        })
      } finally {
        loserClosed = true
      }
    },
  }
  const winner: StreamCandidate<string> = {
    delayMs: 0,
    start: async function* () {
      yield 'w1'
      // Keep the winner stream open long enough to prove losers are closed
      // at win time, not at stream end.
      await wait(80)
      yield 'w2'
    },
  }

  const iter = raceBlockStreams([loser, winner])[Symbol.asyncIterator]()
  const first = await iter.next()
  assert.equal(first.value, 'w1')

  // The loser finishes its 20ms nap, then must be closed promptly — well
  // before the winner's 80ms second block.
  await wait(45)
  assert.equal(loserClosed, true, 'loser generator must be closed at win time')

  const rest = await collect({ [Symbol.asyncIterator]: () => iter })
  assert.deepEqual(rest, ['w2'])
})

test('teardown closes yield-suspended losers and aborts the parked winner', async () => {
  // A generator parked inside an await it never leaves cannot be force-closed
  // (its `finally` runs only when the await settles) — for those, teardown's
  // guarantee is the aborted signal, which real candidates (fetch) observe.
  // A loser suspended at a `yield` CAN be closed, and must be.
  let loserClosed = false
  let winnerSignal: AbortSignal | null = null
  const winner: StreamCandidate<string> = {
    delayMs: 0,
    start: async function* (signal) {
      winnerSignal = signal
      yield 'w1'
      await new Promise<never>(() => {
        // parked; only the aborted signal reaches real code here
      })
    },
  }
  const loser: StreamCandidate<string> = {
    delayMs: 0,
    start: async function* () {
      try {
        await wait(10)
        yield 'loser-block'
      } finally {
        loserClosed = true
      }
    },
  }
  const iter = raceBlockStreams([winner, loser])[Symbol.asyncIterator]()
  const first = await iter.next()
  assert.equal(first.value, 'w1')
  // Consumer walks away while the winner is parked mid-stream.
  await iter.return?.(undefined)
  await wait(30)
  assert.equal(loserClosed, true, 'yield-suspended loser must be closed on teardown')
  assert.equal((winnerSignal as unknown as AbortSignal).aborted, true, 'parked winner must see its signal abort')
})
