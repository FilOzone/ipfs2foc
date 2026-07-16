/**
 * Stall diagnostics (`commp.ts`): a piece that stops advancing can be stuck
 * in two very different places — the network (CAR stream silent) or the hash
 * pool (all workers busy, or a wedged worker). The watchdog previously
 * described every stall as the source going quiet, which sent operators
 * chasing gateways for client-side stalls. `stallMessage` names the phase;
 * only the retrieval flavor keeps the "stopped sending bytes" shape that
 * attributes the stall to the origin.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describePrepareFailure, type PreparePhase, stallMessage } from '../src/commp.ts'

const PHASES: PreparePhase[] = ['retrieve', 'hash-claim', 'hash-write', 'hash-finish']

test('each phase produces a distinct operator-facing stall message', () => {
  const messages = PHASES.map((p) => stallMessage(p, 120))
  assert.equal(new Set(messages).size, PHASES.length, 'phases must be distinguishable in the message')
  for (const m of messages) assert.match(m, /120s/, 'the stall window belongs in the message')
})

test('only the retrieval stall blames the source', () => {
  assert.match(stallMessage('retrieve', 120), /stopped sending bytes/)
  for (const p of PHASES.filter((p) => p !== 'retrieve')) {
    assert.doesNotMatch(
      stallMessage(p, 120),
      /stopped sending bytes/,
      `${p} is a client-side stall; it must not read as an origin problem`
    )
  }
})

test('hash-phase stalls map to an actionable headline, not a gateway one', () => {
  const failure = describePrepareFailure(new Error(stallMessage('hash-claim', 120)))
  assert.doesNotMatch(failure.headline, /source|gateway|network/i)
  assert.match(failure.headline, /hash/i)
})
