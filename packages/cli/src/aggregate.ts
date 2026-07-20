/**
 * Bin-pack pieces into aggregate pieces and compute each aggregate's root
 * PieceCID v2.
 *
 * An aggregate's on-chain padded size is the next power of two of the sum of its
 * sub-pieces' padded sizes, so packing fills greedily while that running sum
 * stays within `aggregateSizeBytes`. The aggregate root is the aggregate piece
 * commitment over the members (see `ipfs2foc-core/piece-aggregate`), the value the provider
 * re-derives on add.
 */

import { Index } from '@web3-storage/data-segment'
import * as Piece from '@web3-storage/data-segment/piece'
import { buildIndexedAggregate } from 'ipfs2foc-core/indexed-aggregate'
import { pieceAggregateCommP } from 'ipfs2foc-core/piece-aggregate'
import type { PieceResult } from './piece.ts'

const NODE_SIZE = 32n
const INDEX_ENTRY_SIZE = 64n

export interface AggregatePlan {
  index: number
  /** Aggregate root PieceCID v2 (aggregate piece commitment). */
  rootPieceCid: string
  members: PieceResult[]
  /** True when the root is an indexed (data segment) aggregate. */
  indexed: boolean
}

export interface PackResult {
  aggregates: AggregatePlan[]
  /** Pieces too large to fit any aggregate of the configured piece size. */
  oversized: PieceResult[]
}

/** A piece's fr32-padded size in bytes, from its PieceCID v2 tree height. */
function paddedSize(pieceCid: string): bigint {
  return 2n ** BigInt(Piece.fromString(pieceCid).height) * NODE_SIZE
}

/**
 * Greedily pack pieces into aggregate pieces whose summed padded size stays
 * within `aggregateSizeBytes` (bounded by the provider's max piece size). Order
 * is preserved; a piece whose own padded size exceeds the budget is reported as
 * oversized.
 */
export function packAggregates(pieces: PieceResult[], aggregateSizeBytes: bigint): PackResult {
  const aggregates: AggregatePlan[] = []
  const oversized: PieceResult[] = []

  let members: PieceResult[] = []
  let used = 0n

  const flush = (): void => {
    if (members.length === 0) {
      return
    }
    const root = pieceAggregateCommP(members.map((m) => ({ pieceCid: m.pieceCid, rawSize: m.rawSize }))).rootPieceCid
    aggregates.push({ index: aggregates.length, rootPieceCid: root, members, indexed: false })
    members = []
    used = 0n
  }

  for (const piece of pieces) {
    const size = paddedSize(piece.pieceCid)
    if (size > aggregateSizeBytes) {
      oversized.push(piece)
      continue
    }
    if (used + size > aggregateSizeBytes) {
      flush()
    }
    members.push(piece)
    used += size
  }

  flush()
  return { aggregates, oversized }
}

/**
 * Pack pieces into indexed (data segment) aggregates. The packing budget
 * reserves the index area up front — `maxIndexEntriesInDeal(dealSize) * 64`
 * padded bytes at the deal's tail — so a full group still fits the deal size
 * with its index. Groups of one skip the wrapper entirely: the piece's own
 * CID is the aggregate root and it is pulled/added as itself (an index over
 * a single entry is rejected by the provider's aggregate parsing).
 */
export function packIndexedAggregates(pieces: PieceResult[], aggregateSizeBytes: bigint): PackResult {
  const maxEntries = BigInt(Index.maxIndexEntriesInDeal(aggregateSizeBytes))
  const budget = aggregateSizeBytes - maxEntries * INDEX_ENTRY_SIZE

  const aggregates: AggregatePlan[] = []
  const oversized: PieceResult[] = []

  let members: PieceResult[] = []
  let used = 0n

  const flush = (): void => {
    if (members.length === 0) {
      return
    }
    if (members.length === 1) {
      aggregates.push({ index: aggregates.length, rootPieceCid: members[0].pieceCid, members, indexed: false })
    } else {
      const root = buildIndexedAggregate(
        members.map((m) => ({ pieceCid: m.pieceCid, rawSize: m.rawSize })),
        { maxDealSize: aggregateSizeBytes }
      ).rootPieceCid
      aggregates.push({ index: aggregates.length, rootPieceCid: root, members, indexed: true })
    }
    members = []
    used = 0n
  }

  for (const piece of pieces) {
    const size = paddedSize(piece.pieceCid)
    if (size > budget) {
      oversized.push(piece)
      continue
    }
    if (used + size > budget || BigInt(members.length) >= maxEntries) {
      flush()
    }
    members.push(piece)
    used += size
  }

  flush()
  return { aggregates, oversized }
}
