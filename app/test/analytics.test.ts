import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ANALYTICS_DOMAIN, eventPayload, shouldReport } from '../src/analytics.ts'

test('reports only from the hosted production site', () => {
  assert.equal(shouldReport('hosted', true, 'ipfsto.filecoin.cloud'), true)
  assert.equal(shouldReport('hosted', true, 'filozone.github.io'), true)
})

test('local backend never reports', () => {
  assert.equal(shouldReport('local', true, 'ipfsto.filecoin.cloud'), false)
})

test('dev builds never report', () => {
  assert.equal(shouldReport('hosted', false, 'ipfsto.filecoin.cloud'), false)
})

test('unknown hosts never report', () => {
  assert.equal(shouldReport('hosted', true, 'localhost'), false)
  assert.equal(shouldReport('hosted', true, 'example.com'), false)
})

test('payload carries name, page url, and the dashboard domain', () => {
  const body = JSON.parse(eventPayload('cli-steer', 'https://ipfsto.filecoin.cloud/?x=1'))
  assert.deepEqual(body, {
    name: 'cli-steer',
    url: 'https://ipfsto.filecoin.cloud/?x=1',
    domain: ANALYTICS_DOMAIN,
  })
})
