import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MigrationDB } from '../src/db.ts'

async function dbAt(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `foc-${name}-`))
  return { dir, db: new MigrationDB(join(dir, 'migrate.db')) }
}

function seedAggregate(db: MigrationDB, idx: number, cid: string) {
  db.addCids([cid])
  db.recordPieceSuccess(cid, `${cid}-piece`, 100, 'g', 'u', `sha-${cid}`)
  db.recordPassthroughSubPiece({
    subPieceCid: `${cid}-piece`,
    sourceCid: cid,
    url: 'u',
    rawSize: 100,
    memberSha256: null,
  })
  db.saveAggregate(idx, `${cid}-root`, 256n, [`${cid}-piece`])
}

test('pullSummary rolls up batch attempts per aggregate', async () => {
  const { dir, db } = await dbAt('pull-summary')
  try {
    seedAggregate(db, 0, 'bafkreia')
    seedAggregate(db, 1, 'bafkreib')
    const a = db.recordPullBatchStart(0, ['p1', 'p2'])
    db.recordPullBatchResult(a, 2, 0)
    const b = db.recordPullBatchStart(0, ['p3'])
    db.recordPullBatchResult(b, 0, 1, 'provider refused the batch')
    const c = db.recordPullBatchStart(1, ['p4'])
    db.recordPullBatchResult(c, 1, 0)

    const summary = db.pullSummary()
    assert.equal(summary.length, 2)
    const agg0 = summary.find((s) => s.aggregateIdx === 0)!
    assert.equal(agg0.attempts, 2)
    assert.equal(agg0.okCount, 2)
    assert.equal(agg0.failedCount, 1)
    assert.equal(agg0.lastError, 'provider refused the batch')
    assert.notEqual(agg0.lastFinishedAt, null)
    const agg1 = summary.find((s) => s.aggregateIdx === 1)!
    assert.equal(agg1.attempts, 1)
    assert.equal(agg1.okCount, 1)
    assert.equal(agg1.failedCount, 0)
    assert.equal(agg1.lastError, null)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('pullSummary is empty before any pdp-submit run', async () => {
  const { dir, db } = await dbAt('pull-empty')
  try {
    seedAggregate(db, 0, 'bafkreia')
    assert.deepEqual(db.pullSummary(), [])
    assert.equal(db.failedSubPieceCount(), 0)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('failedSubPieces lists a bounded slice with the total count', async () => {
  const { dir, db } = await dbAt('pull-failed-subs')
  try {
    seedAggregate(db, 0, 'bafkreia')
    for (let i = 0; i < 5; i++) {
      const cid = `bafkreifail${i}`
      db.addCids([cid])
      db.recordPieceSuccess(cid, `${cid}-piece`, 100, 'g', 'u', `sha-${cid}`)
      db.recordPassthroughSubPiece({
        subPieceCid: `${cid}-piece`,
        sourceCid: cid,
        url: 'u',
        rawSize: 100,
        memberSha256: null,
      })
      db.markSubPieceFailed(`${cid}-piece`, `pull failed ${i}`)
    }
    assert.equal(db.failedSubPieceCount(), 5)
    const listed = db.failedSubPieces(3)
    assert.equal(listed.length, 3)
    for (const sp of listed) {
      assert.match(sp.error ?? '', /^pull failed /)
    }
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
