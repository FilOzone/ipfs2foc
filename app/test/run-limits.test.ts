/**
 * Hosted run ceilings (`run-limits.ts`): the count cap binds at intake, the
 * byte cap once prepared sizes exist, and neither binds when the console is
 * the control plane of a `serve` daemon. The submit ETA math turns
 * committed-chunk samples into seconds left and stays silent until it has a
 * real interval to rate.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chunkEtaSeconds,
  HOSTED_MAX_CIDS,
  HOSTED_MAX_RUN_BYTES,
  LONG_RUN_ADVISORY_SECONDS,
  latchLongRun,
  overByteCap,
  overCidCap,
  runLimits,
} from '../src/run-limits.ts'

test('hosted backend gets the caps, local runs uncapped', () => {
  assert.deepEqual(runLimits({ backend: 'hosted' }), {
    maxCids: HOSTED_MAX_CIDS,
    maxBytes: HOSTED_MAX_RUN_BYTES,
  })
  assert.equal(runLimits({ backend: 'local' }), null)
})

test('count cap binds strictly above the ceiling', () => {
  const limits = runLimits({ backend: 'hosted' })
  assert.equal(overCidCap(HOSTED_MAX_CIDS, limits), false)
  assert.equal(overCidCap(HOSTED_MAX_CIDS + 1, limits), true)
  assert.equal(overCidCap(1_000_000, null), false)
})

test('byte cap binds strictly above the ceiling', () => {
  const limits = runLimits({ backend: 'hosted' })
  assert.equal(overByteCap(HOSTED_MAX_RUN_BYTES, limits), false)
  assert.equal(overByteCap(HOSTED_MAX_RUN_BYTES + 1, limits), true)
  assert.equal(overByteCap(Number.MAX_SAFE_INTEGER, null), false)
})

test('byte ceiling sits at the piece/upload unit', () => {
  // One aggregate's worth: Curio parks a piece of at most about 1 GiB.
  assert.equal(HOSTED_MAX_RUN_BYTES, 1024 * 1024 * 1024)
})

test('long-run note latches at the threshold and never unlatches mid-run', () => {
  // No estimate yet: nothing to latch on.
  assert.equal(latchLongRun(false, null), false)
  // At the threshold exactly: still under, no note.
  assert.equal(latchLongRun(false, LONG_RUN_ADVISORY_SECONDS), false)
  // Past it: latches.
  assert.equal(latchLongRun(false, LONG_RUN_ADVISORY_SECONDS + 1), true)
  // Once latched, a dip back under the threshold or a lost estimate keeps it.
  assert.equal(latchLongRun(true, 30), true)
  assert.equal(latchLongRun(true, null), true)
})

test('chunk ETA needs two samples and a commit between them', () => {
  assert.equal(chunkEtaSeconds([], 3), null)
  assert.equal(chunkEtaSeconds([{ t: 0, n: 0 }], 3), null)
  // Two samples with no commit between them: no rate to project.
  assert.equal(
    chunkEtaSeconds(
      [
        { t: 0, n: 1 },
        { t: 60_000, n: 1 },
      ],
      3
    ),
    null
  )
  assert.equal(chunkEtaSeconds([{ t: 0, n: 0 }], 0), null)
})

test('chunk ETA projects the observed pace onto the remainder', () => {
  // Two commits sixty seconds apart, three chunks left: three more minutes.
  const samples = [
    { t: 0, n: 0 },
    { t: 60_000, n: 1 },
    { t: 120_000, n: 2 },
  ]
  assert.equal(chunkEtaSeconds(samples, 3), 180)
  assert.equal(chunkEtaSeconds(samples, 0), null)
})
