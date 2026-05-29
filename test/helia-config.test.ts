import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLibp2pConfig } from '../src/helia-fallback.ts'

test('libp2p config has no WebRTC transport', async () => {
  const cfg = await buildLibp2pConfig()
  const names = (cfg.transports ?? []).map((t: unknown) => {
    const fn = t as { name?: string; toString?: () => string }
    return (fn.name ?? '') + ' ' + (fn.toString?.() ?? '')
  })
  for (const n of names) {
    assert.equal(/WebRTC/i.test(n), false, `unexpected WebRTC transport: ${n}`)
  }
})

test('libp2p config has no webrtc listen addresses', async () => {
  const cfg = await buildLibp2pConfig()
  const listens = cfg.addresses?.listen ?? []
  for (const addr of listens) {
    assert.equal(/webrtc/i.test(addr), false, `unexpected webrtc listen address: ${addr}`)
  }
})

test('libp2p config keeps TCP transport for outbound dial', async () => {
  const cfg = await buildLibp2pConfig()
  const names = (cfg.transports ?? []).map((t: unknown) => {
    const fn = t as { name?: string; toString?: () => string }
    return (fn.name ?? '') + ' ' + (fn.toString?.() ?? '')
  })
  const hasTcp = names.some((n: string) => /TCP/i.test(n))
  assert.ok(hasTcp, 'expected a TCP transport to remain for outbound dial')
})
