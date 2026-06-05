// Compute a Filecoin PieceCID v2 (commP) over a trustless-gateway CAR by
// streaming the bytes through the hasher — the CAR is never fully buffered, so
// memory stays bounded regardless of object size. Chromium does not implement
// async iteration on a fetch ReadableStream, so the body is consumed via
// getReader().
//
// The hasher is the Rust/WASM fr32 multihash (same multihash code 0x1011 as
// @web3-storage/data-segment/multihash, which src/piece.ts uses) — measured
// ~2x the throughput of the JS implementation (20 -> 39 MiB/s on Apple
// Silicon), which matters because the stream is backpressured by hashing: hash
// speed caps the download speed. PieceCID parity with the JS hasher is pinned
// by test/commp-wasm-parity.test.ts.
import { CarBlockIterator } from '@ipld/car'
import { create as createHasher } from 'fr32-sha2-256-trunc254-padded-binary-tree-multihash'
// Reuse the single source of truth (ipfs2foc-core) — never re-template these, or
// the relay redirect would drift from the bytes commP is computed over.
import { buildCarUrl, CAR_ACCEPT, relayPullUrl, toCanonicalCidV1 } from 'ipfs2foc-core'
import { CID } from 'multiformats/cid'
import * as Raw from 'multiformats/codecs/raw'
import * as Digest from 'multiformats/hashes/digest'
import * as Link from 'multiformats/link'

export interface PieceResult {
  cid: string
  pieceCid: string
  rawSize: number
  gatewayHost: string
  /** The pull URL a provider would be handed via the stateless relay. */
  sourceUrl: string
}

/**
 * Fetch a CID's CAR from the gateway, stream it through the piece hasher, verify
 * the CAR root matches, and return the PieceCID v2 plus the relay pull URL.
 * Streaming, constant-memory — the CAR is never fully buffered.
 */
export async function computePiece(
  gateway: string,
  cidStr: string,
  relayBase: string,
  onProgress?: (bytes: number) => void
): Promise<PieceResult> {
  // Normalize to canonical CIDv1 (CIDv0 `Qm…` is converted automatically), then
  // fetch/commit/relay all under that one form so the commitment stays byte-safe.
  const canonical = toCanonicalCidV1(cidStr)
  if (canonical == null) {
    throw new Error('not a valid CID')
  }
  const expected = CID.parse(canonical)
  const url = buildCarUrl(gateway, canonical)

  const res = await fetch(url, { headers: { accept: CAR_ACCEPT } })
  if (!res.ok) throw new Error(`gateway HTTP ${res.status}`)
  const body = res.body
  if (body == null) throw new Error('no response body (streaming unsupported?)')
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/vnd.ipld.car')) {
    throw new Error(`gateway did not serve a CAR (content-type ${contentType || 'none'})`)
  }

  // WASM hasher holds memory outside the JS heap; free() in the finally below
  // covers both the success path and a throw mid-stream.
  const hasher = createHasher()
  let rawSize = 0

  // Reader is created here (where `body` is narrowed non-null) so the generator
  // closure doesn't have to re-narrow it.
  const reader = body.getReader()
  async function* streamReader(): AsyncGenerator<Uint8Array> {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        yield value
      }
    } finally {
      reader.releaseLock()
    }
  }

  async function* tap(): AsyncGenerator<Uint8Array> {
    for await (const chunk of streamReader()) {
      hasher.write(chunk)
      rawSize += chunk.length
      onProgress?.(rawSize)
      yield chunk
    }
  }

  let pieceCid: string
  try {
    const carReader = await CarBlockIterator.fromIterable(tap())
    for await (const _block of carReader) {
      // drain so the whole CAR flows through the hasher; blocks are not retained
    }
    const roots = await carReader.getRoots()
    if (!roots.some((r) => r.equals(expected) || r.toString() === canonical)) {
      throw new Error(`CAR root mismatch: expected ${canonical}, got [${roots.map((r) => r.toString()).join(', ')}]`)
    }

    // verified: fr32-sha2-256-trunc254-padded-binary-tree-multihash src/async.js
    // digest — multihash bytes come out via digestInto(bytes, 0, true).
    const out = new Uint8Array(hasher.multihashByteLength())
    hasher.digestInto(out, 0, true)
    pieceCid = (Link.create(Raw.code, Digest.decode(out)) as CID).toString()
  } finally {
    hasher.free()
  }
  const gatewayHost = new URL(gateway).hostname
  const sourceUrl = relayPullUrl(relayBase, gatewayHost, canonical, pieceCid)

  return { cid: canonical, pieceCid, rawSize, gatewayHost, sourceUrl }
}
