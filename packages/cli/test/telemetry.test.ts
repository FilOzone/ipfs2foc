import assert from 'node:assert/strict'
import { test } from 'node:test'
import { telemetryOptedOut } from '../src/telemetry.ts'

test('default environment is opted in', () => {
  assert.equal(telemetryOptedOut({}), false)
  assert.equal(telemetryOptedOut({ DO_NOT_TRACK: '' }), false)
  assert.equal(telemetryOptedOut({ DO_NOT_TRACK: '0' }), false)
  assert.equal(telemetryOptedOut({ DO_NOT_TRACK: 'false' }), false)
  assert.equal(telemetryOptedOut({ SCARF_ANALYTICS: 'true' }), false)
})

test('DO_NOT_TRACK opts out on any truthy value', () => {
  assert.equal(telemetryOptedOut({ DO_NOT_TRACK: '1' }), true)
  assert.equal(telemetryOptedOut({ DO_NOT_TRACK: 'true' }), true)
  assert.equal(telemetryOptedOut({ DO_NOT_TRACK: 'TRUE' }), true)
  assert.equal(telemetryOptedOut({ DO_NOT_TRACK: 'yes' }), true)
})

test('SCARF_ANALYTICS=false opts out, case-insensitively', () => {
  assert.equal(telemetryOptedOut({ SCARF_ANALYTICS: 'false' }), true)
  assert.equal(telemetryOptedOut({ SCARF_ANALYTICS: 'False' }), true)
})
