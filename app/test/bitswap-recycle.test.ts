/**
 * Bitswap rescue node recycling (`bitswap-fallback.ts`): the shared node is
 * dropped once its blockstore passes the recycle threshold, but an in-flight
 * block fetch must keep the node it is using alive — stopping it mid-want
 * fails rescues that were about to succeed. Retirement defers the stop until
 * the last lease releases; new fetches get a fresh node immediately.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CID } from 'multiformats/cid'
import { type BitswapNode, createBitswapRescue } from '../src/bitswap-fallback.ts'

const cidOf = (name: string) => ({ toString: () => name }) as unknown as CID
const CID_A = cidOf('bafy-a')
const CID_B = cidOf('bafy-b')
const CID_C = cidOf('bafy-c')

interface FakeNode extends BitswapNode {
  stopped: boolean
  finishGet(cid: CID, bytes?: Uint8Array): void
}

function fakeNode(stored: () => number): FakeNode {
  const pendingGets = new Map<string, (b: Uint8Array) => void>()
  const self: FakeNode = {
    stopped: false,
    finishGet(cid, bytes = new Uint8Array([1])) {
      pendingGets.get(cid.toString())?.(bytes)
      pendingGets.delete(cid.toString())
    },
    getBlock: (cid) =>
      new Promise<Uint8Array>((resolve) => {
        pendingGets.set(cid.toString(), resolve)
      }),
    dial: async () => {},
    stop: async () => {
      self.stopped = true
    },
    storedBytes: stored,
  }
  return self
}

test('a recycle waits for in-flight fetches before stopping the node', async () => {
  let storedA = 0
  const nodes: FakeNode[] = []
  const rescue = createBitswapRescue({
    recycleBytes: 100,
    build: async () => {
      const n = fakeNode(nodes.length === 0 ? () => storedA : () => 0)
      nodes.push(n)
      return n
    },
  })

  // Fetch #1 parks inside getBlock on node A.
  const first = rescue.fetchBlock(['/dns4/p.example/tcp/443/wss/p2p/x'], CID_A)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(nodes.length, 1)

  // Node A crosses the threshold; fetch #2 retires it (deferred) but still
  // completes on it. Node A must not stop while #1 is parked.
  storedA = 1000
  const second = rescue.fetchBlock(['/dns4/p.example/tcp/443/wss/p2p/x'], CID_B)
  await new Promise((r) => setTimeout(r, 0))
  nodes[0].finishGet(CID_B)
  await second
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(nodes[0].stopped, false, 'node A still has fetch #1 leased; it must not stop yet')

  nodes[0].finishGet(CID_A)
  await first
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(nodes[0].stopped, true, 'the last release stops the retired node')

  // A later fetch builds a fresh node instead of reusing the retired one.
  const third = rescue.fetchBlock(['/dns4/p.example/tcp/443/wss/p2p/x'], CID_C)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(nodes.length, 2, 'retirement must hand future fetches a fresh node')
  nodes[1].finishGet(CID_C)
  await third
})

test('a failed build does not poison later fetches', async () => {
  let fail = true
  const rescue = createBitswapRescue({
    build: async () => {
      if (fail) throw new Error('no dialable transports')
      const n = fakeNode(() => 0)
      setTimeout(() => n.finishGet(CID_A), 5)
      return n
    },
  })
  await assert.rejects(rescue.fetchBlock(['/dns4/p.example/tcp/443/wss/p2p/x'], CID_A))
  fail = false
  const bytes = await rescue.fetchBlock(['/dns4/p.example/tcp/443/wss/p2p/x'], CID_A)
  assert.equal(bytes.length, 1)
})
