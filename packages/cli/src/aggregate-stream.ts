/**
 * Stream an indexed aggregate's full byte stream to a provider pull.
 *
 * The response is the exact byte layout the aggregate root commits to (see
 * `ipfs2foc-core/indexed-aggregate`): each sub-piece's canonical CAR at its
 * unpadded offset with zero fill, then the embedded data segment index. The
 * provider recomputes the piece commitment over these bytes on pull, so every
 * sub-piece is hash-verified here as it passes through — a drifted gateway
 * response aborts the stream instead of feeding the provider bytes that can
 * only fail its commP check after the whole download.
 */

import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import type { ServerResponse } from 'node:http'
import * as Hasher from '@web3-storage/data-segment/multihash'
import { buildIndexedAggregate, type IndexedAggregate } from 'ipfs2foc-core/indexed-aggregate'
import type { CID } from 'multiformats/cid'
import * as Raw from 'multiformats/codecs/raw'
import * as Link from 'multiformats/link'
import type { MigrationDB } from './db.ts'
import { fetchCanonicalCar } from './gateway-blocks.ts'
import { log } from './util.ts'

const ZERO_CHUNK = new Uint8Array(64 * 1024)

async function writeChunk(res: ServerResponse, chunk: Uint8Array): Promise<void> {
  if (!res.write(chunk)) {
    await once(res, 'drain')
  }
}

async function writeZeros(res: ServerResponse, length: number): Promise<void> {
  let remaining = length
  while (remaining > 0) {
    const n = Math.min(remaining, ZERO_CHUNK.length)
    await writeChunk(res, n === ZERO_CHUNK.length ? ZERO_CHUNK : ZERO_CHUNK.subarray(0, n))
    remaining -= n
  }
}

/**
 * Recompute the indexed aggregate layout for a planned aggregate row. The
 * layout is deterministic from the member set (the builder re-sorts and picks
 * the smallest fitting deal size), so nothing beyond the members needs to be
 * persisted; the recomputed root is checked against the stored one before any
 * byte is served.
 */
export function layoutForAggregate(db: MigrationDB, idx: number, expectedRoot: string): IndexedAggregate {
  const members = db.aggregateManifest(idx)
  const layout = buildIndexedAggregate(members.map((m) => ({ pieceCid: m.pieceCid, rawSize: m.rawSize })))
  if (layout.rootPieceCid !== expectedRoot) {
    throw new Error(
      `recomputed indexed aggregate root ${layout.rootPieceCid} does not match stored root ${expectedRoot}`
    )
  }
  return layout
}

/**
 * Pipe one sub-piece's canonical CAR into the response while recomputing its
 * piece commitment. Bytes come from the assembled CAR on disk when the
 * sub-piece has one, otherwise from the block-verified canonical gateway
 * stream (`fetchCanonicalCar`) — the same bytes the plan-time commitment was
 * computed over. Returns the byte count written.
 */
async function pipeSubPiece(
  db: MigrationDB,
  res: ServerResponse,
  pieceCid: string,
  expectedLength: number
): Promise<number> {
  const subPiece = db.subPieceByCid(pieceCid)
  if (subPiece == null || subPiece.status !== 'built') {
    throw new Error(`sub-piece ${pieceCid} is ${subPiece == null ? 'unknown' : 'not built'}`)
  }

  const hasher = Hasher.create()
  let written = 0

  const consume = async (chunks: AsyncIterable<Uint8Array>): Promise<void> => {
    for await (const chunk of chunks) {
      hasher.write(chunk)
      written += chunk.length
      if (written > expectedLength) {
        throw new Error(`sub-piece ${pieceCid} produced more than the expected ${expectedLength} bytes`)
      }
      await writeChunk(res, chunk)
    }
  }

  if (subPiece.carPath != null) {
    await consume(createReadStream(subPiece.carPath))
  } else if (subPiece.url != null && subPiece.url !== '') {
    const carUrl = new URL(subPiece.url)
    const sourceCid = carUrl.pathname.replace(/^\/ipfs\//, '')
    const { body } = await fetchCanonicalCar(carUrl.origin, sourceCid)
    await consume(body as unknown as AsyncIterable<Uint8Array>)
  } else {
    throw new Error(`sub-piece ${pieceCid} has neither a CAR file nor a gateway URL`)
  }

  if (written !== expectedLength) {
    throw new Error(`sub-piece ${pieceCid} produced ${written} bytes, expected ${expectedLength}`)
  }
  const recomputed = (Link.create(Raw.code, hasher.digest()) as CID).toString()
  if (recomputed !== pieceCid) {
    throw new Error(`sub-piece bytes recomputed to ${recomputed}, expected ${pieceCid}`)
  }
  return written
}

/**
 * Answer a pull for an indexed aggregate root: `Content-Length` up front, then
 * the regions in stream order. A mid-stream failure destroys the socket — the
 * provider sees a transport abort, never a clean-looking short body.
 */
export async function serveIndexedAggregate(
  db: MigrationDB,
  idx: number,
  expectedRoot: string,
  res: ServerResponse,
  head: boolean
): Promise<void> {
  let layout: IndexedAggregate
  try {
    layout = layoutForAggregate(db, idx, expectedRoot)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`aggregate ${idx}: ${message}`)
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('aggregate layout unavailable')
    return
  }

  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(layout.streamLength),
    'cache-control': 'no-store',
  })
  if (head) {
    res.end()
    return
  }

  try {
    for (const region of layout.regions) {
      if (region.kind === 'zero') {
        await writeZeros(res, region.length)
      } else if (region.kind === 'index') {
        await writeChunk(res, layout.indexBytes)
      } else {
        const member = layout.members[region.memberIndex]
        const written = await pipeSubPiece(db, res, member.pieceCid, region.payloadLength)
        await writeZeros(res, region.length - written)
      }
    }
    res.end()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`aggregate ${idx}: stream aborted — ${message}`)
    res.destroy()
  }
}
