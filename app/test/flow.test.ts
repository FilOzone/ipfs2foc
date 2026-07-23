import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveStage, estimateCostUsdfc, type FlowSnapshot, historyEntries, type StorageRate } from '../src/flow.ts'

const base: FlowSnapshot = {
  prepareStarted: false,
  running: false,
  preparedCount: 0,
  reviewedPrepare: false,
  costAccepted: false,
  canSign: false,
  submitStarted: false,
  allCommitted: false,
}

test('deriveStage walks the flow in order', () => {
  assert.equal(deriveStage(base), 'intake')
  assert.equal(deriveStage({ ...base, prepareStarted: true, running: true }), 'prepare')
  // Settled but not reviewed: the operator is still looking at results.
  assert.equal(deriveStage({ ...base, prepareStarted: true, preparedCount: 4 }), 'prepare')
  assert.equal(deriveStage({ ...base, prepareStarted: true, preparedCount: 4, reviewedPrepare: true }), 'cost')
  assert.equal(
    deriveStage({ ...base, prepareStarted: true, preparedCount: 4, reviewedPrepare: true, costAccepted: true }),
    'wallet'
  )
  assert.equal(
    deriveStage({
      ...base,
      prepareStarted: true,
      preparedCount: 4,
      reviewedPrepare: true,
      costAccepted: true,
      canSign: true,
    }),
    'submit'
  )
})

test('a run with zero prepared pieces stays at prepare', () => {
  assert.equal(deriveStage({ ...base, prepareStarted: true, reviewedPrepare: true }), 'prepare')
})

test('a restored submit wins over earlier steps; committed wins over all', () => {
  assert.equal(deriveStage({ ...base, submitStarted: true }), 'submit')
  assert.equal(deriveStage({ ...base, prepareStarted: true, submitStarted: true }), 'submit')
  assert.equal(deriveStage({ ...base, submitStarted: true, allCommitted: true }), 'receipt')
})

test('historyEntries lists exactly the completed steps, in order', () => {
  const x = { cidCount: 124, preparedCount: 121, prepareTotal: 124, costLabel: '≈0.12 USDFC / month', dataSetCount: 2 }
  assert.deepEqual(historyEntries('intake', x), [])
  assert.deepEqual(
    historyEntries('prepare', x).map((e) => e.stage),
    ['intake']
  )
  assert.deepEqual(
    historyEntries('wallet', x).map((e) => e.stage),
    ['intake', 'prepare', 'cost']
  )
  const receipt = historyEntries('receipt', x)
  assert.deepEqual(
    receipt.map((e) => e.stage),
    ['intake', 'prepare', 'cost', 'wallet', 'submit']
  )
  assert.equal(receipt[0].label, 'Listed 124 items')
  assert.equal(receipt[1].label, 'Prepared 121 of 124')
  assert.equal(receipt[2].label, 'Cost ≈0.12 USDFC / month')
  assert.equal(receipt[4].label, 'Migrated, 2 data sets')
})

test('historyEntries falls back when no estimate existed', () => {
  const entries = historyEntries('wallet', {
    cidCount: 1,
    preparedCount: 1,
    prepareTotal: 1,
    costLabel: null,
    dataSetCount: 0,
  })
  assert.equal(entries[2].label, 'Cost reviewed')
})

const rate: StorageRate = {
  pricePerTiBPerMonth: 2_500_000_000_000_000_000n, // 2.5 USDFC / TiB / month
  minimumPricePerMonth: 100_000_000_000_000_000n, // 0.1 USDFC floor per data set
}

test('estimateCostUsdfc floors small runs at the per-data-set minimum', () => {
  // 100 MiB is far below where the size-based rate beats the floor.
  const est = estimateCostUsdfc(100 * 1024 * 1024, 2, rate)
  assert.equal(est, 2n * rate.minimumPricePerMonth)
})

test('estimateCostUsdfc scales with size, copies, and months once above the floor', () => {
  const oneTiB = 2 ** 40
  assert.equal(estimateCostUsdfc(oneTiB, 1, rate), rate.pricePerTiBPerMonth)
  assert.equal(estimateCostUsdfc(oneTiB, 3, rate), 3n * rate.pricePerTiBPerMonth)
  assert.equal(estimateCostUsdfc(oneTiB, 1, rate, 6), 6n * rate.pricePerTiBPerMonth)
})

test('estimateCostUsdfc is zero for empty inputs', () => {
  assert.equal(estimateCostUsdfc(0, 2, rate), 0n)
  assert.equal(estimateCostUsdfc(1024, 0, rate), 0n)
})
