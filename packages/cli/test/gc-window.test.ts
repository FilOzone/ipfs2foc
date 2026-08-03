import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bandwidthFloorBytesPerSec,
  collectedCidFromError,
  DEFAULT_ASSUMED_WINDOW_MS,
  lowerWindowOnGc,
  MAX_ADD_PIECES_BATCH,
  MIN_MARGIN_MS,
  MIN_WINDOW_MS,
  marginFromConfirmations,
  shouldFlush,
} from '../src/gc-window.ts'

// Locks in the flush-scheduling rules from issue #70: every tie breaks toward
// flushing sooner, and the window estimate only ever moves down.

const base = {
  batchSize: 1,
  oldestParkedAtMs: 0,
  nowMs: 0,
  assumedWindowMs: DEFAULT_ASSUMED_WINDOW_MS,
  marginMs: MIN_MARGIN_MS,
  drained: false,
}

test('shouldFlush: empty batch never flushes, even drained', () => {
  assert.equal(shouldFlush({ ...base, batchSize: 0, drained: true }), null)
})

test('shouldFlush: full batch flushes regardless of timers', () => {
  assert.equal(shouldFlush({ ...base, batchSize: MAX_ADD_PIECES_BATCH }), 'batch-full')
})

test('shouldFlush: window expiry includes the margin', () => {
  const edge = DEFAULT_ASSUMED_WINDOW_MS - MIN_MARGIN_MS
  assert.equal(shouldFlush({ ...base, nowMs: edge - 1 }), null)
  assert.equal(shouldFlush({ ...base, nowMs: edge }), 'window')
})

test('shouldFlush: drained flushes a partial batch', () => {
  assert.equal(shouldFlush({ ...base, drained: true }), 'drained')
})

test('marginFromConfirmations: floor without observations, 2x worst with', () => {
  assert.equal(marginFromConfirmations([]), MIN_MARGIN_MS)
  assert.equal(marginFromConfirmations([1_000, 2_000]), MIN_MARGIN_MS)
  const slow = 20 * 60_000
  assert.equal(marginFromConfirmations([1_000, slow]), 2 * slow)
})

test('lowerWindowOnGc: lowers from evidence, never raises, floors', () => {
  const hourMs = 60 * 60_000
  assert.equal(lowerWindowOnGc(hourMs, 40 * 60_000), 30 * 60_000)
  // Evidence above the current guess must not raise it.
  assert.equal(lowerWindowOnGc(hourMs, 10 * hourMs), hourMs)
  assert.equal(lowerWindowOnGc(hourMs, 0), MIN_WINDOW_MS)
})

test('bandwidthFloorBytesPerSec: matches the issue-70 example order of magnitude', () => {
  // ~1016 MiB over 2h minus 10 min margin ≈ 1.3 Mbit/s ≈ 162 KB/s.
  const floor = bandwidthFloorBytesPerSec(1_065_353_216, 2 * 60 * 60_000, 10 * 60_000)
  assert.ok(floor > 100_000 && floor < 250_000, `unexpected floor ${floor}`)
})

test('collectedCidFromError: parses the Curio GC rejection and nothing else', () => {
  const cid = 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa'
  assert.equal(
    collectedCidFromError(`Failed to process request: subPiece CID ${cid} not found or does not belong to service foo`),
    cid
  )
  assert.equal(collectedCidFromError('insufficient funds'), null)
})
