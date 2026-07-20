/**
 * Indexed aggregate layout parity.
 *
 * The decisive check mirrors what the provider does on pull: recompute the
 * piece commitment over the assembled byte stream and require it to equal the
 * aggregate root CID. That only holds if every sub-piece region, zero gap,
 * and the fr32-unpadded index tail sit at exactly the offsets go-data-segment's
 * `AggregateObjectReader` would emit.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Fr32, Piece, Segment } from '@web3-storage/data-segment'
import { buildIndexedAggregate } from 'ipfs2foc-core/indexed-aggregate'

const ENTRY_SIZE = 64

function payloadOf(byteLength: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(byteLength)
  for (let i = 0; i < byteLength; i++) {
    bytes[i] = (i * 31 + seed * 7 + ((i >> 8) & 0xff)) & 0xff
  }
  return bytes
}

function subPieceOf(byteLength: number, seed: number): { pieceCid: string; rawSize: number; payload: Uint8Array } {
  const payload = payloadOf(byteLength, seed)
  const piece = Piece.fromPayload(payload)
  return { pieceCid: piece.link.toString(), rawSize: byteLength, payload }
}

function assembleStream(
  aggregate: ReturnType<typeof buildIndexedAggregate>,
  payloads: Map<string, Uint8Array>
): Uint8Array {
  const stream = new Uint8Array(aggregate.streamLength)
  for (const region of aggregate.regions) {
    if (region.kind === 'piece') {
      const member = aggregate.members[region.memberIndex]
      const payload = payloads.get(member.pieceCid)
      assert.ok(payload, `payload for ${member.pieceCid}`)
      assert.equal(payload.length, region.payloadLength)
      stream.set(payload, region.start)
    } else if (region.kind === 'index') {
      stream.set(aggregate.indexBytes, region.start)
    }
  }
  return stream
}

test('assembled stream recomputes to the aggregate root CID', () => {
  const subs = [subPieceOf(200_000, 1), subPieceOf(65_000, 2), subPieceOf(130_000, 3)]
  const aggregate = buildIndexedAggregate(subs.map(({ pieceCid, rawSize }) => ({ pieceCid, rawSize })))

  // Regions must cover [0, streamLength) contiguously.
  let cursor = 0
  for (const region of aggregate.regions) {
    assert.equal(region.start, cursor)
    cursor += region.length
  }
  assert.equal(cursor, aggregate.streamLength)

  const stream = assembleStream(aggregate, new Map(subs.map((s) => [s.pieceCid, s.payload])))

  // The provider's pull-side verification: commP over the exact bytes.
  const recomputed = Piece.fromPayload(stream)
  assert.equal(recomputed.link.toString(), aggregate.rootPieceCid)
})

test('index entries round-trip to member offsets and pass checksum', () => {
  const subs = [subPieceOf(500_000, 4), subPieceOf(300_000, 5), subPieceOf(70_000, 6), subPieceOf(66_000, 7)]
  const aggregate = buildIndexedAggregate(subs.map(({ pieceCid, rawSize }) => ({ pieceCid, rawSize })))

  // Members are sorted largest padded size first and sit at non-overlapping,
  // 127-multiple (fr32 quantum) offsets.
  for (const [i, member] of aggregate.members.entries()) {
    assert.equal(member.offset % 127, 0)
    if (i > 0) {
      assert.ok(member.offset >= aggregate.members[i - 1].offset + aggregate.members[i - 1].length)
    }
  }

  // Re-pad the index area and decode the 64-byte descriptors: root must match
  // each member's piece root, offsets must map back via unpadded = x - x/128,
  // and the trailing checksum must be exactly what Segment.toBytes computes.
  const entryArea = aggregate.indexBytes.subarray(
    0,
    Math.ceil((aggregate.members.length * ENTRY_SIZE * 127) / 128 / 127) * 127
  )
  const padded = Fr32.pad(entryArea)
  for (const [i, member] of aggregate.members.entries()) {
    const entry = padded.subarray(i * ENTRY_SIZE, (i + 1) * ENTRY_SIZE)
    const root = entry.subarray(0, 32)
    const view = new DataView(entry.buffer, entry.byteOffset)
    const paddedOffset = view.getBigUint64(32, true)
    const paddedSize = view.getBigUint64(40, true)
    assert.deepEqual(root, Piece.fromString(member.pieceCid).root)
    assert.equal(Number(paddedOffset - paddedOffset / 128n), member.offset)
    assert.equal(Number(paddedSize - paddedSize / 128n), member.length)
    const expected = Segment.toBytes({ root, offset: paddedOffset, size: paddedSize })
    assert.deepEqual(entry, expected)
  }
})

test('rejects a single sub-piece and oversized payloads', () => {
  const only = subPieceOf(10_000, 8)
  assert.throws(() => buildIndexedAggregate([{ pieceCid: only.pieceCid, rawSize: only.rawSize }]), RangeError)

  const a = subPieceOf(10_000, 9)
  const b = subPieceOf(10_000, 10)
  assert.throws(
    () =>
      buildIndexedAggregate([
        { pieceCid: a.pieceCid, rawSize: 10_000_000 },
        { pieceCid: b.pieceCid, rawSize: b.rawSize },
      ]),
    RangeError
  )
})
