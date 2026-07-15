// Compute a Filecoin PieceCID v2 (commP) over the canonical trustless CAR for
// a CID, assembled in-browser from hash-verified blocks.
//
// The bytes hashed are NOT a raw gateway response. The DAG is retrieved as a
// single streaming `?format=car&dag-scope=all` request per root
// (`ipfs2foc-core/car-stream-source`): a trustless gateway emits the CAR in the
// same depth-first, first-occurrence order the canonical exporter walks, so
// retrieval latency is paid once for the stream instead of once per block. Every
// block is hash-verified against its CID before it is served, and any block the
// stream never delivers falls through to a single verified `?format=raw` fetch;
// the bytes are then serialized locally by the shared canonical exporter
// (`ipfs2foc-core/car-export`: CARv1, dag-scope=all, dfs, dups=n with an exact
// dedup set, bounded-lookahead prefetch). Because blocks are content-addressed,
// that serialization is byte-identical to what a spec-compliant gateway serves
// from `buildCarUrl` — the URL the provider later pulls — which is pinned by
// `test/car-export-byte-identity.test.ts` and the live PieceCID pins. Unlike
// hashing a gateway stream, a truncated or flaky source can never produce a
// commitment over incomplete bytes: an unavailable block fails the walk
// loudly.
//
// This mirrors the CLI prepare path (`src/gateway-blocks.ts`): no helia node,
// pure `fetch` + `@ipld/car` + multiformats, so first paint stays light. The
// per-call `CarStreamSource` is scoped to one root and torn down (`close()`)
// when the export ends — no persistent broker/session state to carry across
// CIDs.
//
// Threading: retrieval and CAR assembly run HERE on the main thread; the
// CPU-bound fr32 hashing runs in pooled workers (`hash-pool.ts`), one core per
// concurrent piece, fed transferred chunks with per-chunk acknowledgement as
// backpressure.
//
// Memory stays bounded regardless of DAG size: the exporter holds at most
// `lookahead` blocks in flight, and the CAR-stream reorder buffer is a hard cap
// so retrieved blocks are not retained after they are written to the CAR.
// Reuse the single source of truth (ipfs2foc-core) — never re-template these, or
// the relay redirect would drift from the bytes commP is computed over.
import { relayPullUrl, toCanonicalCidV1 } from 'ipfs2foc-core'
import { messagesOf } from 'ipfs2foc-core/block-source'
import { exportCanonicalCar } from 'ipfs2foc-core/car-export'
import {
  CarStreamSource,
  defaultGetCodec,
  fetchGatewayRawBlock,
  openGatewayCarStream,
} from 'ipfs2foc-core/car-stream-source'
import { CID } from 'multiformats/cid'
import * as Raw from 'multiformats/codecs/raw'
import * as Digest from 'multiformats/hashes/digest'
import * as Link from 'multiformats/link'
import { fetchBlockViaBitswap } from './bitswap-fallback.ts'
import { beginHash, type HashJob } from './hash-pool.ts'
import { discoverRootSources } from './provider-discovery.ts'

// A piece whose canonical CAR fits here is fetched entirely without holding a
// hash worker (#59): the buffered bytes hand off to a worker only when the
// stream ends, so the CPU pool spends its time hashing, not waiting on the
// network. In the inventories this tool targets most pieces are far smaller;
// larger ones switch to streaming through the worker mid-fetch. Worst-case
// transient memory is this cap times the prepare concurrency.
const HASH_HANDOFF_BYTES = 4 * 1024 * 1024

export interface PieceResult {
  cid: string
  pieceCid: string
  rawSize: number
  gatewayHost: string
  /** The pull URL a provider would be handed via the stateless relay. */
  sourceUrl: string
  /**
   * Blocks the gateway's CAR stream did not cover, recovered per-block. A
   * non-zero count means the CAR the provider later pulls from the same URL was
   * incomplete for this root, so the operator should re-verify the gateway
   * before submitting — same warning the CLI logs.
   */
  gapFillCount: number
}

export interface PrepareFailure {
  /** One line naming the action an operator takes. */
  headline: string
  /** The deduplicated underlying error chain, for inspection. */
  detail: string
}

/** Map a prepare failure to the action an operator takes (#34). */
export function describePrepareFailure(err: unknown): PrepareFailure {
  const msgs = messagesOf(err)
  const detail = [...new Set(msgs)].join(' ← ')
  const headline = (() => {
    if (msgs.some((m) => m === 'not a valid CID')) return 'not a valid CID'
    if (msgs.some((m) => /did not match multihash/.test(m))) {
      return 'gateway returned bytes that do not match the CID. Switch gateway.'
    }
    if (msgs.some((m) => /received (429|5\d\d) /.test(m))) {
      return 'gateway kept timing out on a block. It is likely not cached there; retry, or switch gateway.'
    }
    if (msgs.some((m) => /received (404|410) /.test(m))) {
      return 'the gateway does not have this content. Switch gateway.'
    }
    if (msgs.some((m) => /Failed to fetch|NetworkError/i.test(m))) {
      return 'network failure while fetching. Check connectivity and retry.'
    }
    if (msgs.some((m) => /stopped sending bytes/.test(m))) {
      return 'source stalled. It is not serving this CID right now; retry later.'
    }
    return msgs[0] ?? 'failed'
  })()
  return { headline, detail }
}

/**
 * Race a promise against `signal`. The hash-worker protocol has no abort
 * channel — a request parked on a dead or suspended worker never settles — so
 * abort wins the race and the caller terminates the worker via `job.cancel()`
 * (the pool replaces it). The orphaned promise is dropped, not awaited.
 */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal == null) return p
  return new Promise<T>((resolve, reject) => {
    const reason = () => (signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError'))
    if (signal.aborted) {
      reject(reason())
      return
    }
    const onAbort = () => reject(reason())
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      }
    )
  })
}

/**
 * Retrieve a CID's DAG from the gateway as one streaming CAR request per root
 * (hash-verified, per-block gap-fill on the side), stream the canonical CAR
 * through a pooled piece hasher, and return the PieceCID v2 plus the relay pull
 * URL. Streaming, constant-memory — the CAR is never fully buffered. The
 * `CarStreamSource` owns and closes its own stream, so there is no persistent
 * node to carry across calls.
 *
 * Aborting `signal` tears down the gateway stream, releases (and replaces) the
 * hash-pool worker, and rejects with the abort reason — the stall watchdog and
 * the per-row cancel both come through here (#43).
 */
export async function computePiece(
  gateway: string,
  cidStr: string,
  relayBase: string,
  onProgress?: (bytes: number) => void,
  signal?: AbortSignal
): Promise<PieceResult> {
  // Normalize to canonical CIDv1 (CIDv0 `Qm…` is converted automatically), then
  // export/commit/relay all under that one form so the commitment stays byte-safe.
  const canonical = toCanonicalCidV1(cidStr)
  if (canonical == null) {
    throw new Error('not a valid CID')
  }
  const root = CID.parse(canonical)

  // One streaming `?format=car` request per root; blocks served from the
  // verified stream, with a per-block `?format=raw` fallback for any the stream
  // misses. Scoped to this root and closed when the export ends.
  //
  // The CAR is asked for from the root's own providers first (#59): delegated
  // routing names the hosts that hold this content, and pulling from them
  // spreads a big run across the network instead of funneling it through one
  // gateway. Any discovery or candidate failure falls through — the
  // configured gateway is always the last candidate. The commitment cannot
  // depend on the choice: every block is hash-verified, and the canonical
  // CAR is a pure function of the content.
  //
  // One routing lookup serves the whole piece: the CAR candidates and the
  // bitswap rescue below share it.
  const sources = discoverRootSources(canonical, signal)
  const openCarStream = async function* (root: Parameters<typeof openGatewayCarStream>[1], streamSignal?: AbortSignal) {
    const { carUrls } = await sources
    let lastErr: unknown = null
    for (const base of [...carUrls, gateway]) {
      try {
        yield* openGatewayCarStream(base, root, streamSignal)
        return
      } catch (err) {
        if (streamSignal?.aborted === true) throw err
        // A candidate that died mid-stream may have delivered blocks already;
        // re-streaming from the next one is safe — the source drops
        // duplicates after verifying them.
        lastErr = err
      }
    }
    throw lastErr
  }
  // Gap-fill: the gateway's single-block raw fetch first (unchanged), then a
  // bitswap want to the root's own browser-dialable peers. The rescue only
  // engages when every HTTP path for a block is exhausted, so a root nothing
  // HTTP can serve still prepares as long as one of its peers answers.
  const fetchRawBlock = async (cid: CID, blockSignal?: AbortSignal) => {
    try {
      return await fetchGatewayRawBlock(gateway, cid, blockSignal)
    } catch (gatewayErr) {
      const { p2pAddrs } = await sources
      try {
        return await fetchBlockViaBitswap(p2pAddrs, cid, blockSignal)
      } catch (bitswapErr) {
        throw new AggregateError([gatewayErr, bitswapErr], 'gateway raw fetch and bitswap rescue both failed')
      }
    }
  }
  const source = new CarStreamSource(gateway, { signal, openCarStream, fetchRawBlock })
  // The hash worker is claimed only once there are bytes worth hashing (#59).
  // Claiming it up front held a CPU core through the whole network stream, so
  // four slow fetches gated every other piece. A piece that fits the buffer
  // completes its entire fetch without a worker and holds one only for the
  // hash itself; larger pieces hand off mid-stream and continue as before,
  // with the unpulled stream as backpressure while they wait for a slot.
  let jobPromise: Promise<HashJob> | null = null
  let job: HashJob | null = null
  const buffered: Uint8Array[] = []
  let bufferedBytes = 0
  // Claim a worker and replay the buffered bytes into it. Called at most
  // once per piece: both call sites are guarded by `job == null`.
  const handOff = async (claim: Promise<HashJob>): Promise<HashJob> => {
    const j = await raceAbort(claim, signal)
    for (const c of buffered) await raceAbort(j.write(c), signal)
    buffered.length = 0
    return j
  }
  let rawSize = 0
  let pieceCid: string
  try {
    for await (const chunk of exportCanonicalCar(source, defaultGetCodec, root, { signal })) {
      rawSize += chunk.length
      if (job == null) {
        buffered.push(chunk)
        bufferedBytes += chunk.length
        if (bufferedBytes >= HASH_HANDOFF_BYTES) {
          jobPromise = beginHash()
          job = await handOff(jobPromise)
        }
      } else {
        await raceAbort(job.write(chunk), signal)
      }
      onProgress?.(rawSize)
    }
    if (job == null) {
      jobPromise = beginHash()
      job = await handOff(jobPromise)
    }

    // verified: fr32-sha2-256-trunc254-padded-binary-tree-multihash src/async.js
    // digest — multihash bytes come out via digestInto(bytes, 0, true).
    pieceCid = (Link.create(Raw.code, Digest.decode(await raceAbort(job.finish(), signal))) as CID).toString()
  } catch (err) {
    // A claim can still be in flight (abort or stream failure won the race);
    // cancel on arrival so the pool slot is replaced, not leaked.
    if (job == null) {
      jobPromise?.then(
        (j) => j.cancel(),
        () => {
          // the claim itself failed; there is no slot to release
        }
      )
    } else {
      job.cancel()
    }
    throw err
  } finally {
    source.close()
  }
  const gatewayHost = new URL(gateway).hostname
  const sourceUrl = relayPullUrl(relayBase, gatewayHost, canonical, pieceCid)

  return { cid: canonical, pieceCid, rawSize, gatewayHost, sourceUrl, gapFillCount: source.gapFillCount }
}
