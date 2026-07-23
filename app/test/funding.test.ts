import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveFundingState, FIL_GAS_FLOOR, type FundingInputs, fundingChecklist } from '../src/funding.ts'
import type { PaymentsStatus } from '../src/payments.ts'

const funded: PaymentsStatus = {
  fil: FIL_GAS_FLOOR * 5n,
  walletUsdfc: 0n,
  depositedUsdfc: 10n * 10n ** 18n,
  availableUsdfc: 10n * 10n ** 18n,
  operatorApproved: true,
}

const base: FundingInputs = {
  providerDetected: true,
  connected: true,
  onTargetNetwork: true,
  networkLabel: 'Mainnet',
  payments: funded,
  requiredUsdfc: 3n * 10n ** 18n,
  signingEnabled: false,
  filSymbol: 'FIL',
}

test('exactly one row is blocked and it is the first unmet one', () => {
  const rows = fundingChecklist({ ...base, payments: { ...funded, fil: 0n, operatorApproved: false } })
  assert.deepEqual(
    rows.map((r) => r.state),
    ['done', 'done', 'blocked', 'done', 'waiting', 'waiting']
  )
  assert.equal(rows[2].id, 'fil')
})

test('fully funded wallet blocks only on signing', () => {
  const rows = fundingChecklist(base)
  assert.deepEqual(
    rows.map((r) => `${r.id}:${r.state}`),
    ['wallet:done', 'connect:done', 'fil:done', 'usdfc:done', 'approve:done', 'signing:blocked']
  )
})

test('no extension blocks the first row and everything waits', () => {
  const rows = fundingChecklist({ ...base, providerDetected: false, connected: false, payments: null })
  assert.equal(rows[0].state, 'blocked')
  assert.ok(rows.slice(1).every((r) => r.state === 'waiting'))
})

test('usdfc row compares available against the estimate and names undeposited funds', () => {
  const p = { ...funded, availableUsdfc: 1n * 10n ** 18n, walletUsdfc: 5n * 10n ** 18n }
  const rows = fundingChecklist({ ...base, payments: p })
  const usdfc = rows.find((r) => r.id === 'usdfc')
  assert.equal(usdfc?.state, 'blocked')
  assert.match(usdfc?.detail ?? '', /1\.0000 USDFC available of ≈3\.0000 USDFC needed/)
  assert.match(usdfc?.detail ?? '', /5\.0000 USDFC in the wallet, not yet deposited/)
})

test('gas floor boundary: at the floor passes, below it blocks', () => {
  const at = fundingChecklist({ ...base, payments: { ...funded, fil: FIL_GAS_FLOOR } })
  assert.equal(at.find((r) => r.id === 'fil')?.state, 'done')
  const under = fundingChecklist({ ...base, payments: { ...funded, fil: FIL_GAS_FLOOR - 1n } })
  assert.equal(under.find((r) => r.id === 'fil')?.state, 'blocked')
})

test('wrong network reports through the connect row', () => {
  const rows = fundingChecklist({ ...base, onTargetNetwork: false })
  const connect = rows.find((r) => r.id === 'connect')
  assert.equal(connect?.state, 'blocked')
  assert.match(connect?.title ?? '', /Connected on Mainnet/)
})

test('funding state names the active blocker', () => {
  assert.equal(deriveFundingState({ ...base, providerDetected: false }), 'wallet-none')
  assert.equal(deriveFundingState({ ...base, connected: false }), null)
  assert.equal(deriveFundingState({ ...base, payments: null }), 'wallet-connected')
  assert.equal(deriveFundingState({ ...base, payments: { ...funded, fil: 0n } }), 'no-fil')
  assert.equal(deriveFundingState({ ...base, payments: { ...funded, availableUsdfc: 0n } }), 'no-usdfc')
  assert.equal(deriveFundingState({ ...base, payments: { ...funded, operatorApproved: false } }), 'not-approved')
  assert.equal(deriveFundingState({ ...base, signingEnabled: true }), 'signing-enabled')
  assert.equal(deriveFundingState(base), 'wallet-connected')
})
