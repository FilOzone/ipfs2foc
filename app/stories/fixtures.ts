/**
 * Shared story fixtures. CIDs and piece commitments are real values from
 * test runs, so widths, truncation, and copy read exactly as they will live.
 */

import type { PieceRowView } from '../src/components/piece-row.tsx'
import { HOSTED_MAX_CIDS, HOSTED_MAX_RUN_BYTES, type RunLimits } from '../src/run-limits.ts'

export const HOSTED_LIMITS: RunLimits = { maxCids: HOSTED_MAX_CIDS, maxBytes: HOSTED_MAX_RUN_BYTES }

export const CIDS = [
  'bafybeia2222m75lxmc3ex7g3whuwwua76c2atzsi6uwkonnwrbm75loapa',
  'bafybeia222di4kgrows5yijrxhfncqbzqa43k2dmbxradelbdg4lt7alzm',
  'bafybeia222ftr2e4vho3ateu47vtaeb6k25dozie3t75n2x7txyzwxoncq',
]

export const PIECE_CIDS = [
  'bafkzcibe2wiqcdjy7lq3dgv54ketriu5l3vfsuyclrzu5geapxmsux5pyqokfgywgm',
  'bafkzcibdyvna3ftjljv7slftdir7wv2bbd5bhyyexqdn6ia6zix4k6qdf6z5y3rl',
  'bafkzcibdvnua2zr4mqfbzadtipdk2srcgbhzralvvb2x4y6lgc6swebcakpfgdbv',
]

const GATEWAY = 'https://trustless-gateway.link/ipfs'

export const ROW_DONE: PieceRowView = {
  phase: 'done',
  cid: CIDS[0],
  pieceCid: PIECE_CIDS[0],
  rawSize: 4_654_066,
  sourceUrl: `${GATEWAY}/${CIDS[0]}?format=car`,
  gapFillCount: 0,
}

export const ROW_DONE_GAP_FILLED: PieceRowView = {
  ...ROW_DONE,
  cid: CIDS[1],
  pieceCid: PIECE_CIDS[1],
  gapFillCount: 3,
}

export const ROW_WORKING: PieceRowView = {
  phase: 'working',
  cid: CIDS[2],
  bytes: 1_834_221,
  rate: 2.4,
}

export const ROW_FAILED: PieceRowView = {
  phase: 'error',
  cid: CIDS[1],
  message: 'gateway is not serving this CID right now; retry later',
  detail: 'HTTP 504 from trustless-gateway.link after 3 attempts over 96s; last body: upstream timeout',
}

export const ROW_QUEUED: PieceRowView = { phase: 'queued', cid: CIDS[2] }

export const noop = (): void => undefined
