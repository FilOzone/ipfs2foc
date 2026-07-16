/**
 * Learned routing reuse (`provider-discovery.ts`): after enough real lookups
 * agree on the gateway answer, the answer is reused without a lookup — but
 * reuse must not discard the bitswap rescue path. A cached answer carries
 * the most recent browser-dialable peer addrs seen for that gateway answer,
 * so a root whose HTTP tiers all fail can still fall through to bitswap
 * without waiting for a failed attempt and a fresh retry lookup.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRootDiscovery } from '../src/provider-discovery.ts'

const GATEWAY_PROVIDER = {
  Protocols: ['transport-ipfs-gateway-http'],
  Addrs: ['/dns/main.gw.example/tcp/443/https'],
}
const PEER_PROVIDER = (host: string) => ({
  ID: '12D3KooWpeer',
  Addrs: [`/dns4/${host}/tcp/4001/tls/ws`],
})

function stubRouting(answers: () => object) {
  const original = globalThis.fetch
  const state = { calls: 0 }
  globalThis.fetch = (async () => {
    state.calls++
    return new Response(JSON.stringify(answers()), { status: 200 })
  }) as typeof fetch
  return { state, restore: () => (globalThis.fetch = original) }
}

test('reuse engages after enough identical gateway answers', async () => {
  const discovery = createRootDiscovery({ learnAfter: 3, revalidateEvery: 100 })
  const { state, restore } = stubRouting(() => ({ Providers: [GATEWAY_PROVIDER] }))
  try {
    for (let i = 0; i < 3; i++) await discovery.discover(`bafy-root-${i}`)
    assert.equal(state.calls, 3)
    const cached = await discovery.discover('bafy-root-cached')
    assert.equal(state.calls, 3, 'a learned answer must not issue a lookup')
    assert.deepEqual(cached.carUrls, ['https://main.gw.example'])
  } finally {
    restore()
  }
})

test('a learned answer carries the most recent peer addrs, not none', async () => {
  const discovery = createRootDiscovery({ learnAfter: 3, revalidateEvery: 100 })
  let host = 'peer-a.example'
  const { state, restore } = stubRouting(() => ({ Providers: [GATEWAY_PROVIDER, PEER_PROVIDER(host)] }))
  try {
    await discovery.discover('bafy-1')
    host = 'peer-b.example'
    await discovery.discover('bafy-2')
    await discovery.discover('bafy-3')
    const cached = await discovery.discover('bafy-cached')
    assert.equal(state.calls, 3)
    assert.deepEqual(
      cached.p2pAddrs,
      ['/dns4/peer-b.example/tcp/4001/tls/ws/p2p/12D3KooWpeer'],
      'the cached answer must keep the bitswap rescue path'
    )
  } finally {
    restore()
  }
})

test('fresh forces a real lookup even while an answer is learned', async () => {
  const discovery = createRootDiscovery({ learnAfter: 2, revalidateEvery: 100 })
  const { state, restore } = stubRouting(() => ({ Providers: [GATEWAY_PROVIDER] }))
  try {
    await discovery.discover('bafy-1')
    await discovery.discover('bafy-2')
    await discovery.discover('bafy-cached')
    assert.equal(state.calls, 2)
    await discovery.discover('bafy-retry', undefined, true)
    assert.equal(state.calls, 3, 'fresh=true must bypass the learned answer')
  } finally {
    restore()
  }
})

test('answers without a gateway record teach nothing and break nothing', async () => {
  const discovery = createRootDiscovery({ learnAfter: 3, revalidateEvery: 100 })
  let empty = false
  const { state, restore } = stubRouting(() => ({
    Providers: empty ? [PEER_PROVIDER('peer-a.example')] : [GATEWAY_PROVIDER],
  }))
  try {
    await discovery.discover('bafy-1')
    empty = true
    await discovery.discover('bafy-2')
    empty = false
    await discovery.discover('bafy-3')
    await discovery.discover('bafy-4')
    assert.equal(state.calls, 4, 'not learned yet: the empty answer must not count toward the streak')
    const cached = await discovery.discover('bafy-cached')
    assert.equal(state.calls, 4, 'three gateway answers seen: reuse engages despite the interleaved empty one')
    assert.deepEqual(cached.carUrls, ['https://main.gw.example'])
  } finally {
    restore()
  }
})
