/**
 * Indexed aggregate (FRC-0058 data segment) construction, in pure JS.
 *
 * Unlike the bare aggregate commitment in `piece-aggregate` (sub-piece trees
 * combined with zero padding, no self-description), an indexed aggregate
 * embeds a data segment index in the piece's tail. The provider can recover
 * every sub-piece from the aggregate bytes alone: it seeks to the index start
 * offset, parses the entries, and reads each sub-piece at its recorded
 * offset. This is the layout Curio's aggregate indexing consumes
 * (`tasks/indexing/index_helpers.go IndexAggregate` reads the index via
 * `datasegment.DataSegmentIndexStartOffset` + `parseDataSegmentIndex`).
 *
 * The byte stream this module describes mirrors go-data-segment
 * `Aggregate.AggregateObjectReader` (verified: filecoin-project/go-data-segment
 * datasegment/creation.go AggregateObjectReader):
 *
 *   [sub-piece 0 bytes][zero fill]...[sub-piece n bytes][zero fill]
 *   [zero gap][fr32-unpadded index entries][zero fill to end]
 *
 * All offsets and lengths are in the unpadded (raw byte) domain:
 *   unpadded(x) = x - x/128   (verified: datasegment/index.go
 *   SegmentDesc.UnpaddedOffest / UnpaddedLength)
 *
 * The index start is `unpadded(dealSize) - unpadded(maxEntries * 64)`
 * (verified: datasegment/parse_index.go DataSegmentIndexStartOffset), and each
 * serialized entry is 64 bytes: root(32) || offset u64 LE || size u64 LE ||
 * checksum(16) (`@web3-storage/data-segment` `Segment.toBytes`, which cites
 * go's index.go serialization). The entry bytes land in the stream fr32
 * -unpadded (verified: datasegment/creation.go IndexReader).
 *
 * The aggregate root includes the index nodes, so the piece commitment binds
 * the index: `Aggregate.build` places each entry's two nodes into the tree the
 * same way go-data-segment's `NewAggregate` does.
 *
 * Pure module - no `node:` imports - so the browser app can build the same
 * aggregates the CLI submits.
 */

import { Aggregate, type API, Fr32, Index, Piece, Segment } from '@web3-storage/data-segment'

/**
 * `AggregateView` omits the `index` field the builder's `Aggregate` class
 * carries at runtime (upstream type gap; see `.research/upstream-gaps.md`).
 */
type BuiltAggregate = API.AggregateView & { index: API.SegmentInfo[] }

const ENTRY_SIZE = 64
const FR32_QUANTUM = 128n

/** unpadded(x): bytes of payload that fr32-expand to `x` padded bytes. */
function unpadded(size: bigint): bigint {
  return size - size / FR32_QUANTUM
}

export interface IndexedAggregateSubPiece {
  /** Sub-piece PieceCID v2. */
  pieceCid: string
  /** Actual byte length of the sub-piece payload (the CAR). */
  rawSize: number
}

export interface IndexedAggregateMember {
  pieceCid: string
  rawSize: number
  /** Start of this sub-piece's region in the aggregate byte stream. */
  offset: number
  /** Region length; `rawSize` payload bytes then zero fill. */
  length: number
}

export type IndexedAggregateRegion =
  | { kind: 'piece'; start: number; length: number; memberIndex: number; payloadLength: number }
  | { kind: 'zero'; start: number; length: number }
  | { kind: 'index'; start: number; length: number }

export interface IndexedAggregate {
  /** Aggregate PieceCID v2; rawSize is the full stream length. */
  rootPieceCid: string
  /** Members in stream order (largest padded size first). */
  members: IndexedAggregateMember[]
  /** Padded (on-chain) aggregate size in bytes; a power of two. */
  dealSize: bigint
  /** Total unpadded byte-stream length: unpadded(dealSize). */
  streamLength: number
  /** Unpadded offset where the serialized index begins. */
  indexStartOffset: number
  /** Serialized index: fr32-unpadded entries, zero-filled to the index area. */
  indexBytes: Uint8Array
  /** Contiguous cover of [0, streamLength): what to emit, in order. */
  regions: IndexedAggregateRegion[]
}

/**
 * Build the indexed aggregate over sub-pieces. Sub-pieces are laid out
 * largest-padded-first (matching `piece-aggregate` ordering, which minimizes
 * alignment gaps). Throws RangeError when the pieces cannot fit any deal size
 * up to `maxDealSize` (default 64 GiB, the provider ceiling).
 */
export function buildIndexedAggregate(
  subPieces: IndexedAggregateSubPiece[],
  options: { maxDealSize?: bigint } = {}
): IndexedAggregate {
  if (subPieces.length < 2) {
    // Curio's IndexAggregate requires at least 2 entries; a single piece
    // should be submitted as itself, not wrapped.
    throw new RangeError(`indexed aggregate needs at least 2 sub-pieces, got ${subPieces.length}`)
  }
  const maxDealSize = options.maxDealSize ?? 2n ** 36n

  const entries = subPieces
    .map((sp) => {
      const piece = Piece.fromString(sp.pieceCid)
      return { pieceCid: sp.pieceCid, rawSize: sp.rawSize, piece }
    })
    .sort((a, b) => b.piece.height - a.piece.height)

  // Every sub-piece payload must fit its own padded tree, or the zero fill
  // would truncate real bytes.
  for (const e of entries) {
    const capacity = unpadded(2n ** BigInt(e.piece.height) * 32n)
    if (BigInt(e.rawSize) > capacity) {
      throw new RangeError(`sub-piece ${e.pieceCid} rawSize ${e.rawSize} exceeds its padded capacity ${capacity}`)
    }
  }

  // Find the smallest power-of-two deal size the builder accepts: alignment
  // gaps and the index reservation mean the sum of padded sizes is only a
  // lower bound.
  const sumPadded = entries.reduce((acc, e) => acc + 2n ** BigInt(e.piece.height) * 32n, 0n)
  let dealSize = 2n ** BigInt(sumPadded.toString(2).length - ((sumPadded & (sumPadded - 1n)) === 0n ? 1 : 0))
  let aggregate: BuiltAggregate | undefined
  for (; dealSize <= maxDealSize; dealSize *= 2n) {
    try {
      aggregate = Aggregate.build({
        pieces: entries.map((e) => e.piece),
        size: Aggregate.Size.from(dealSize),
      }) as BuiltAggregate
      break
    } catch (err) {
      if (err instanceof RangeError) {
        continue
      }
      throw err
    }
  }
  if (aggregate === undefined) {
    throw new RangeError(`sub-pieces do not fit an aggregate of at most ${maxDealSize} padded bytes`)
  }

  const streamLength = Number(unpadded(dealSize))

  // Index area geometry (verified: go-data-segment parse_index.go
  // DataSegmentIndexStartOffset; @web3-storage/data-segment index.js
  // maxIndexEntriesInDeal matches go's MaxIndexEntriesInDeal).
  const maxEntries = Index.maxIndexEntriesInDeal(dealSize)
  const indexAreaLength = Number(unpadded(BigInt(maxEntries * ENTRY_SIZE)))
  const indexStartOffset = streamLength - indexAreaLength

  // Serialize the entries exactly as go's IndexReader does: concatenated
  // 64-byte descriptors, zero-padded to a 128-byte multiple, fr32-unpadded,
  // then zero-filled to the index area.
  const segmentBytes = new Uint8Array(Math.ceil((aggregate.index.length * ENTRY_SIZE) / 128) * 128)
  for (const [i, segment] of aggregate.index.entries()) {
    segmentBytes.set(Segment.toBytes(segment), i * ENTRY_SIZE)
  }
  const unpaddedEntries = Fr32.unpad(segmentBytes)
  const indexBytes = new Uint8Array(indexAreaLength)
  indexBytes.set(unpaddedEntries, 0)

  // Members and regions in stream order. `aggregate.index` preserves write
  // order (largest-first), and each entry's padded offset/size convert to the
  // unpadded domain by the go formulas above.
  const members: IndexedAggregateMember[] = []
  const regions: IndexedAggregateRegion[] = []
  let cursor = 0
  for (const [i, segment] of aggregate.index.entries()) {
    const start = Number(unpadded(segment.offset))
    const length = Number(unpadded(segment.size))
    if (start < cursor) {
      throw new Error(`aggregate layout error: segment ${i} starts at ${start}, before cursor ${cursor}`)
    }
    if (start > cursor) {
      regions.push({ kind: 'zero', start: cursor, length: start - cursor })
    }
    const member = entries[i]
    members.push({ pieceCid: member.pieceCid, rawSize: member.rawSize, offset: start, length })
    regions.push({ kind: 'piece', start, length, memberIndex: i, payloadLength: member.rawSize })
    cursor = start + length
  }
  if (indexStartOffset < cursor) {
    throw new Error(`aggregate layout error: index starts at ${indexStartOffset}, before cursor ${cursor}`)
  }
  if (indexStartOffset > cursor) {
    regions.push({ kind: 'zero', start: cursor, length: indexStartOffset - cursor })
  }
  regions.push({ kind: 'index', start: indexStartOffset, length: indexAreaLength })

  // The v2 envelope carries the full stream length as payload: padding 0 and
  // the deal tree's own height, so the provider's recomputed commP over
  // exactly `streamLength` pulled bytes matches this CID.
  const rootPieceCid = Piece.toLink({ root: aggregate.root, height: aggregate.height, padding: 0n }).toString()

  return { rootPieceCid, members, dealSize, streamLength, indexStartOffset, indexBytes, regions }
}
