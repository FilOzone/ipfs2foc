import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The pinned gateway-CAR contract (#19/#29 lineage), shared by every test
 * that asserts it: the hermetic fixture replay (commp-fixture-parity) and the
 * live gateway canary (commp-piece-cid-regression). One list so the pins
 * cannot drift apart across files — a live-canary failure and a fixture-test
 * failure must be disagreements about bytes, never about which values were
 * pinned.
 */
export interface PinnedCar {
  cid: string
  /** sha256 + size of the direct `?format=car…` gateway CAR (pinned). */
  sha256: string
  bytes: number
  /** PieceCID v2 computed over that CAR. */
  pieceCid: string
}

export const PINNED_CARS: PinnedCar[] = [
  {
    cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    sha256: '89795ad1b0d2a9a712e67989122929c56bfa00ef3c1e063aca86d19a4025f589',
    bytes: 119874,
    pieceCid: 'bafkzcibdxzhqyefkufvnsmqlyrjyr3el6affnfo3l7ipfncjjzjl4hkaqhbaema3',
  },
  {
    cid: 'bafybeia2yt37rxkqu7ovw6ja3nf2aqatrzpcwh2tvl2kqbgeqcccn5evhy',
    sha256: '57aec52dbfc093616afb482a8eec4c877fba1bbf209e4b115764c131a88a0cbc',
    bytes: 5010728,
    pieceCid: 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa',
  },
]

/** Path of the committed fixture CAR for a pinned CID. */
export function fixtureCarPath(cid: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cars', `${cid}.car`)
}
