/**
 * Console union dedupe (`cid-union.ts`): a CID pasted in one spelling and
 * loaded from a file in another must count once, keyed the same way the file
 * intake keys rows (canonical CIDv1, first occurrence keeps its spelling).
 * Unparseable strings still dedupe on raw text and survive to the prepare
 * pass, which is where they are rejected visibly.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CID } from 'multiformats/cid'
import { dedupeCanonical, invalidCidStrings } from '../src/cid-union.ts'

// A real CIDv0 and its v1 re-encoding, plus the v1 in base58btc spelling.
const V0 = 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n'
const V1 = CID.parse(V0).toV1().toString()

test('v0 and v1 spellings of the same CID collapse to one entry', () => {
  assert.deepEqual(dedupeCanonical([V0, V1]), [V0])
})

test('first occurrence wins and keeps its input spelling', () => {
  assert.deepEqual(dedupeCanonical([V1, V0]), [V1])
})

test('distinct CIDs and repeated raw strings behave as before', () => {
  const other = CID.parse('bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy').toString()
  assert.deepEqual(dedupeCanonical([V0, other, V0, 'not-a-cid', 'not-a-cid']), [V0, other, 'not-a-cid'])
})

test('invalidCidStrings names the unparseable entries, deduped, in order', () => {
  assert.deepEqual(invalidCidStrings([V0, 'not-a-cid', V1, 'hello', 'not-a-cid']), ['not-a-cid', 'hello'])
})

test('invalidCidStrings is empty for an all-valid list', () => {
  assert.deepEqual(invalidCidStrings([V0, V1]), [])
})
