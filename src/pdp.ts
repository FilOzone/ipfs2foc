/**
 * Curio PDP HTTP client for the pull + aggregate-add migration path.
 *
 * Two calls, both authorized by an FWSS `extraData` blob (the provider's HTTP
 * layer is open; the on-chain `eth_call` of AddPieces is the real gate):
 *
 *   POST /pdp/piece/pull              — provider pulls each sub-piece CAR from
 *                                       its sourceUrl (the redirect server → gateway),
 *                                       verifies CommP, parks it. Idempotent:
 *                                       re-POST the same body to poll status.
 *   POST /pdp/data-sets/{id}/pieces   — add one aggregate piece over the parked
 *                                       sub-pieces; one on-chain AddPieces.
 *
 * No Authorization header: a default public PDP provider runs NullAuth (service
 * "public"). Authorization is carried entirely by `extraData`.
 */

import type { Hex } from 'viem'

export type PullPieceStatus = 'pending' | 'inProgress' | 'retrying' | 'complete' | 'failed'

export interface PullPieceInput {
  pieceCid: string
  sourceUrl: string
}

export interface PullResponse {
  status: PullPieceStatus
  pieces: Array<{ pieceCid: string; status: PullPieceStatus }>
}

export class PdpClient {
  #base: string

  constructor(serviceURL: string) {
    this.#base = serviceURL.replace(/\/+$/, '')
  }

  /**
   * Submit (or poll, when re-sent with the same body) a pull request. The body
   * is the idempotency key via `sha256(extraData)` + dataSetId, so reuse one
   * `extraData` per batch for both the submit and its status polls.
   */
  async pull(body: { extraData: Hex; dataSetId: number; pieces: PullPieceInput[] }): Promise<PullResponse> {
    const res = await fetch(`${this.#base}/pdp/piece/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ extraData: body.extraData, dataSetId: body.dataSetId, pieces: body.pieces }),
    })
    if (res.status === 429) {
      const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '60', 10)
      throw new PullBackpressure(retryAfter)
    }
    if (!res.ok) {
      throw new Error(`pull: HTTP ${res.status} ${await res.text()}`)
    }
    return (await res.json()) as PullResponse
  }

  /**
   * Add one aggregate piece over already-parked sub-pieces. Returns the AddPieces
   * transaction hash (from the Location header) and a status URL to poll.
   */
  async addAggregate(
    dataSetId: number,
    aggregateRootPieceCid: string,
    subPieceCids: string[],
    extraData: Hex
  ): Promise<{ txHash: string; statusUrl: string }> {
    const res = await fetch(`${this.#base}/pdp/data-sets/${dataSetId}/pieces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pieces: [
          {
            pieceCid: aggregateRootPieceCid,
            subPieces: subPieceCids.map((subPieceCid) => ({ subPieceCid })),
          },
        ],
        extraData,
      }),
    })
    if (!res.ok) {
      throw new Error(`addPieces: HTTP ${res.status} ${await res.text()}`)
    }
    const location = res.headers.get('location') ?? ''
    const txHash = location.split('/').pop() ?? ''
    return { txHash, statusUrl: location }
  }

  /**
   * Poll an AddPieces transaction to terminal state.
   *
   * Curio's response carries three independent signals
   * (`pdp/handlers.go:handleGetPieceAdditionStatus`):
   *
   *   txStatus      'pending' | 'confirmed' | 'failed'  — chain landing only
   *   addMessageOk  bool | null                          — inner AddPieces call succeeded (receipt status == 1)
   *   piecesAdded   bool                                 — Curio finished its downstream bookkeeping
   *
   * A reverted AddPieces tx gives `txStatus='confirmed'` with `addMessageOk=false`,
   * so a confirmed tx is not a sufficient success signal on its own. `ok` requires
   * all three: chain confirmed, inner call succeeded, Curio's piece IDs queryable.
   * `confirmedPieceIds` is the canonical on-chain piece-id mapping for the batch.
   */
  async addStatus(
    dataSetId: number,
    txHash: string
  ): Promise<{ done: boolean; ok: boolean; reason?: string; confirmedPieceIds?: number[] }> {
    const res = await fetch(`${this.#base}/pdp/data-sets/${dataSetId}/pieces/added/${txHash}`)
    if (res.status === 404) {
      return { done: false, ok: false } // tx not yet observed by Curio
    }
    if (!res.ok) {
      throw new Error(`addStatus: HTTP ${res.status} ${await res.text()}`)
    }
    const body = (await res.json()) as {
      txStatus?: string
      addMessageOk?: boolean | null
      piecesAdded?: boolean
      confirmedPieceIds?: number[]
    }

    if (body.txStatus === 'failed') {
      return { done: true, ok: false, reason: 'tx failed on chain' }
    }
    if (body.txStatus === 'confirmed') {
      if (body.addMessageOk === false) {
        return { done: true, ok: false, reason: 'AddPieces tx confirmed but reverted (receipt status 0)' }
      }
      if (body.addMessageOk === true && body.piecesAdded === true) {
        return { done: true, ok: true, confirmedPieceIds: body.confirmedPieceIds }
      }
      // Confirmed on chain but Curio's bookkeeping has not caught up (addMessageOk
      // still null, or piecesAdded false). Keep polling.
      return { done: false, ok: false }
    }
    // txStatus 'pending' or anything else: keep polling.
    return { done: false, ok: false }
  }
}

/** Thrown when the provider returns 429; carries the suggested retry delay. */
export class PullBackpressure extends Error {
  retryAfterSeconds: number
  constructor(retryAfterSeconds: number) {
    super(`pull backpressure; retry after ${retryAfterSeconds}s`)
    this.retryAfterSeconds = retryAfterSeconds
  }
}
