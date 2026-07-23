/**
 * Submit gate for gap-filled pieces (`submit.ts`): a piece whose CAR stream
 * needed per-block gap-fill computed a correct commitment locally, but the
 * provider pulls the CAR URL — if that URL still serves an incomplete CAR at
 * pull time, the on-chain AddPieces fails and burns the batch. Those pieces
 * are held back from submit until a retry completes with a clean stream
 * (gapFillCount 0), instead of riding in on a tooltip warning.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PieceResult } from '../src/commp.ts'
import { partitionSubmittable } from '../src/submit.ts'

const piece = (cid: string, gapFillCount: number): PieceResult => ({
  cid,
  pieceCid: `piece-${cid}`,
  rawSize: 1024,
  gatewayHost: 'gw.example',
  sourceUrl: `https://gw.example/ipfs/${cid}?format=car`,
  gapFillCount,
})

test('clean pieces submit; gap-filled pieces are held back', () => {
  const { eligible, heldBack } = partitionSubmittable([piece('a', 0), piece('b', 3), piece('c', 0)])
  assert.deepEqual(
    eligible.map((p) => p.cid),
    ['a', 'c']
  )
  assert.deepEqual(
    heldBack.map((p) => p.cid),
    ['b']
  )
})

test('an all-clean list is untouched and an all-gapped list is all held', () => {
  const clean = [piece('a', 0), piece('b', 0)]
  assert.deepEqual(partitionSubmittable(clean), { eligible: clean, heldBack: [] })
  const gapped = [piece('a', 1)]
  assert.deepEqual(partitionSubmittable(gapped), { eligible: [], heldBack: gapped })
})
