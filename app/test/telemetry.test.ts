import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redactUserData } from '../src/error-tracking.ts'
import { cidCountBucket, deriveStep, type FunnelSnapshot, milestonesCrossed } from '../src/telemetry.ts'

const base: FunnelSnapshot = {
  cidCount: 0,
  walletConnected: false,
  preparing: false,
  preparedDone: 0,
  prepareTotal: 0,
  prepareErrors: 0,
  costAccepted: false,
  submitting: false,
  runCompleted: false,
}

test('deriveStep walks the funnel in order, later stages winning', () => {
  assert.equal(deriveStep(base), 'landed')
  assert.equal(deriveStep({ ...base, cidCount: 3 }), 'input')
  assert.equal(deriveStep({ ...base, cidCount: 3, walletConnected: true }), 'wallet')
  assert.equal(deriveStep({ ...base, cidCount: 3, walletConnected: true, preparing: true }), 'preparing')
  assert.equal(deriveStep({ ...base, cidCount: 3, prepareTotal: 3, preparedDone: 3 }), 'prepared')
  // Errors count toward completion: a run that ended with failures is still past prepare.
  assert.equal(deriveStep({ ...base, cidCount: 3, prepareTotal: 3, preparedDone: 2, prepareErrors: 1 }), 'prepared')
  assert.equal(deriveStep({ ...base, cidCount: 3, prepareTotal: 3, preparedDone: 3, costAccepted: true }), 'cost')
  assert.equal(
    deriveStep({ ...base, cidCount: 3, prepareTotal: 3, preparedDone: 3, costAccepted: true, walletConnected: true }),
    'wallet'
  )
  assert.equal(deriveStep({ ...base, submitting: true }), 'submitting')
  assert.equal(deriveStep({ ...base, submitting: true, runCompleted: true }), 'done')
})

test('cidCountBucket boundaries', () => {
  assert.equal(cidCountBucket(1), '1-10')
  assert.equal(cidCountBucket(10), '1-10')
  assert.equal(cidCountBucket(11), '11-50')
  assert.equal(cidCountBucket(100), '51-100')
  assert.equal(cidCountBucket(101), '101-500')
  assert.equal(cidCountBucket(500), '101-500')
  assert.equal(cidCountBucket(501), '501+')
})

test('milestonesCrossed reports every quarter reached, none for empty runs', () => {
  assert.deepEqual(milestonesCrossed(0, 0), [])
  assert.deepEqual(milestonesCrossed(0, 4), [])
  assert.deepEqual(milestonesCrossed(1, 4), [25])
  assert.deepEqual(milestonesCrossed(3, 4), [25, 50, 75])
  assert.deepEqual(milestonesCrossed(4, 4), [25, 50, 75, 100])
})

test('redactUserData strips CIDs and addresses, keeps the rest', () => {
  const v0 = `Qm${'b'.repeat(44)}`
  const msg = `pull failed for bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi and ${v0} from 0x${'a'.repeat(40)}: timeout`
  const out = redactUserData(msg)
  assert.equal(out.includes('bafybei'), false)
  assert.equal(out.includes('Qm'), false)
  assert.equal(out.includes('0xaaaa'), false)
  assert.equal(out.includes('pull failed'), true)
  assert.equal(out.includes('timeout'), true)
  assert.equal(out, `pull failed for [cid] and [cid] from [address]: timeout`)
})
