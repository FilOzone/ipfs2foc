import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MigrationDB } from '../src/db.ts'
import {
  type DirectUploadDeps,
  type DirectUploadOptions,
  runDirectUpload,
  type UploadContextLike,
} from '../src/direct-upload.ts'

// Drives the real runDirectUpload control flow with fake providers, to lock in
// the issue-70 guarantees: store-then-batch-commit, the add_unconfirmed
// breadcrumb, GC detection lowering the window and re-storing only what is
// actually gone, and CAR eviction only after every copy is committed.

// Real PieceCIDs so CID.parse succeeds.
const P1 = 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa'
const P2 = 'bafkzcibewpkqwewyhz3yxutlxbpt2nkb6si5qilg4qqtzzij32uw7ammsc73a4wkgi'

const OPTS: DirectUploadOptions = { network: 'calibration', copies: 2 }

async function dbAt(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `foc-${name}-`))
  return { dir, db: new MigrationDB(join(dir, 'migrate.db')) }
}

function seedBuilt(db: MigrationDB, subPieceCid: string, carPath: string) {
  const src = `src-${subPieceCid.slice(-8)}`
  db.addCids([src])
  db.recordPieceSuccess(src, subPieceCid, 1024, 'g', `https://gw/ipfs/${src}?format=car`, null)
  db.recordBuiltSubPiece({
    subPieceCid,
    assembledCarLength: 1024,
    targetSizeBytes: 1024,
    carPath,
    assembledSha256: 'sha',
    members: [{ cid: src, sha256: null, rawSize: 1024 }],
  })
}

interface FakeBehavior {
  /** Throw on the numbered commit call (1-based) on the given provider. */
  failCommit?: { providerId: string; call: number; message: string }
  /** Per-CID presence answers for hasPiece during re-verify. */
  present?: (cid: string) => boolean
  pullFails?: boolean
}

function fakeDeps(b: FakeBehavior = {}) {
  const calls = { store: [] as string[], pull: 0, commit: new Map<string, number>() }
  const evicted: string[] = []
  const mkCtx = (providerId: string): UploadContextLike => ({
    providerId,
    serviceURL: `fake://${providerId}`,
    dataSetId: null,
    async store(_data, options) {
      calls.store.push(`${providerId}:${String(options.pieceCid)}`)
      return { pieceCid: options.pieceCid, size: 1024 }
    },
    async pull(options) {
      calls.pull++
      const status = b.pullFails ? 'failed' : 'complete'
      return { status, pieces: options.pieces.map((p) => ({ pieceCid: p, status })) }
    },
    async commit(options) {
      const n = (calls.commit.get(providerId) ?? 0) + 1
      calls.commit.set(providerId, n)
      const f = b.failCommit
      if (f != null && f.providerId === providerId && f.call === n) {
        throw new Error(f.message)
      }
      return {
        txHash: `0xtx-${providerId}-${n}`,
        pieceIds: options.pieces.map((_, i) => BigInt(i)),
        dataSetId: 7n,
      }
    },
    getPieceUrl: (pieceCid) => `fake://${providerId}/piece/${String(pieceCid)}`,
    hasPiece: async (pieceCid) => (b.present ? b.present(String(pieceCid)) : true),
  })
  const deps: DirectUploadDeps = {
    async setup() {
      return { contexts: [mkCtx('p1'), mkCtx('p2')] }
    },
    now: () => Date.now(),
    openCar: () => new Uint8Array(8),
    evictCar: async (path) => {
      evicted.push(path)
    },
  }
  return { deps, calls, evicted }
}

test('happy path: stores on primary, pulls to secondary, drained flush commits both, evicts CARs', async () => {
  const { dir, db } = await dbAt('du-happy')
  try {
    seedBuilt(db, P1, join(dir, 'a.car'))
    seedBuilt(db, P2, join(dir, 'b.car'))
    const { deps, calls, evicted } = fakeDeps()
    const summary = await runDirectUpload(db, OPTS, deps)

    assert.deepEqual(calls.store, [`p1:${P1}`, `p1:${P2}`])
    assert.equal(calls.pull, 2)
    // One drained flush per provider, both pieces in one batch.
    assert.equal(calls.commit.get('p1'), 1)
    assert.equal(calls.commit.get('p2'), 1)
    for (const provider of ['p1', 'p2']) {
      const committed = db.uploadsByStatus(provider, 'committed')
      assert.deepEqual(committed.map((u) => u.subPieceCid).sort(), [P2, P1].sort())
      for (const u of committed) assert.equal(u.dataSetId, '7')
    }
    assert.equal(evicted.length, 2)
    assert.equal(summary.providers[0].committed, 2)
    assert.equal(summary.providers[0].role, 'primary')
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('secondary pull failure leaves the primary committed and the secondary failed', async () => {
  const { dir, db } = await dbAt('du-pullfail')
  try {
    seedBuilt(db, P1, join(dir, 'a.car'))
    const { deps, evicted } = fakeDeps({ pullFails: true })
    await runDirectUpload(db, OPTS, deps)

    assert.equal(db.uploadsByStatus('p1', 'committed').length, 1)
    assert.equal(db.uploadsByStatus('p2', 'failed').length, 1)
    // The CAR must survive: the secondary copy never landed.
    assert.equal(evicted.length, 0)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('GC rejection: lowers the provider window, re-stores only the collected piece, keeps the rest parked', async () => {
  const { dir, db } = await dbAt('du-gc')
  try {
    seedBuilt(db, P1, join(dir, 'a.car'))
    seedBuilt(db, P2, join(dir, 'b.car'))
    const { deps, calls } = fakeDeps({
      failCommit: {
        providerId: 'p1',
        call: 1,
        message: `Failed to process request: subPiece CID ${P1} not found or does not belong to service svc`,
      },
      present: (cid) => cid !== P1,
    })
    await runDirectUpload(db, OPTS, deps)

    // P1 was re-stored on the primary after being collected; P2 was not.
    const p1Stores = calls.store.filter((s) => s === `p1:${P1}`).length
    assert.equal(p1Stores, 2)
    assert.equal(calls.store.filter((s) => s === `p1:${P2}`).length, 1)
    // Both pieces end up committed via the retry flush.
    assert.equal(db.uploadsByStatus('p1', 'committed').length, 2)
    // The window guess dropped below the default for the flaky provider only.
    const defaultMs = 60 * 60_000
    assert.ok(db.providerWindowMs('p1', defaultMs) < defaultMs)
    assert.equal(db.providerWindowMs('p2', defaultMs), defaultMs)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('non-GC commit failure leaves the batch add_unconfirmed, and a later run reconciles it', async () => {
  const { dir, db } = await dbAt('du-unconfirmed')
  try {
    seedBuilt(db, P1, join(dir, 'a.car'))
    const first = fakeDeps({
      failCommit: { providerId: 'p1', call: 1, message: 'insufficient funds' },
    })
    await runDirectUpload(db, OPTS, first.deps)
    assert.equal(db.uploadsByStatus('p1', 'add_unconfirmed').length, 1)

    // Second run: the piece is still parked on the provider, so the resume
    // reconciliation re-queues it and the commit lands — without re-storing.
    const second = fakeDeps()
    await runDirectUpload(db, OPTS, second.deps)
    assert.equal(db.uploadsByStatus('p1', 'committed').length, 1)
    assert.equal(second.calls.store.filter((s) => s.startsWith('p1:')).length, 0)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
