import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildLibp2pConfig, getHelia, stopHeliaFallback } from '../src/helia-fallback.ts'

// Regression guard for #18. The embedded fallback node is assembled by hand
// from @libp2p/* + @helia/utils rather than helia's createHelia/libp2pDefaults,
// because importing the `helia` barrel statically pulls @libp2p/webrtc →
// node-datachannel, whose native binding is not prebuilt for Node 26 and throws
// at import time. These tests fail the moment WebRTC re-enters the graph: either
// buildLibp2pConfig() throws (a helia/libp2pDefaults import crept back in) or a
// WebRTC transport / listen address reappears.

test('libp2p config builds without pulling a native binding', async () => {
  // Throws if @libp2p/webrtc → node-datachannel were back in the import graph.
  const cfg = await buildLibp2pConfig()
  assert.ok(Array.isArray(cfg.transports) && cfg.transports.length === 2)
})

test('libp2p config has no WebRTC transport', async () => {
  const cfg = await buildLibp2pConfig()
  const names = (cfg.transports ?? []).map((t: unknown) => {
    const fn = t as { [Symbol.toStringTag]?: string; toString?: () => string }
    return `${fn[Symbol.toStringTag] ?? ''} ${fn.toString?.() ?? ''}`
  })
  for (const n of names) {
    assert.equal(/webrtc/i.test(n), false, `unexpected WebRTC transport: ${n}`)
  }
})

test('libp2p config has no listen addresses (outbound-only, no webrtc-direct)', async () => {
  const cfg = await buildLibp2pConfig()
  assert.deepEqual(cfg.addresses?.listen ?? [], [])
})

test('embedded Helia node starts and stops without the node-datachannel crash', async () => {
  // The strongest #18 guard: the whole fallback path stands up and tears down.
  const helia = await getHelia()
  assert.ok(helia.libp2p.peerId, 'expected a started libp2p node')
  await stopHeliaFallback()
})
