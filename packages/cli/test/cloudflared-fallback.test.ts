// The http2 fallback (#48): a quick tunnel that prints its URL but never
// registers with the edge (outbound 7844 blocked) is killed and respawned
// once with --protocol http2. Driven by a stub binary so no network or real
// cloudflared is involved; the registration log line itself is pinned by a
// live observation documented in redirect-server-cloudflared.ts.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startCloudflaredTunnel } from '../src/redirect-server-cloudflared.ts'

/** A stand-in cloudflared: prints a URL always; registers only under --protocol http2. */
function stubBinary(opts: { registerOnDefault: boolean; registerOnHttp2: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-stub-'))
  const path = join(dir, 'cloudflared-stub.sh')
  writeFileSync(
    path,
    `#!/bin/sh
case "$*" in
  *http2*) REGISTER=${opts.registerOnHttp2 ? 1 : 0}; HOST=stub-http2 ;;
  *)       REGISTER=${opts.registerOnDefault ? 1 : 0}; HOST=stub-quic ;;
esac
echo "INF |  https://$HOST.trycloudflare.com  |"
if [ "$REGISTER" = "1" ]; then
  echo "INF Registered tunnel connection connIndex=0 protocol=stub"
else
  echo "INF |  ERROR: Allow outbound QUIC traffic on port 7844 or use HTTP2.  |"
fi
# stay alive like the real binary; the caller kills us
sleep 60
`,
    { mode: 0o755 }
  )
  return path
}

const FAST = { startupTimeoutMs: 5_000, registrationTimeoutMs: 2_000 }

test('registered tunnel on the default transport is used as-is', async () => {
  const { baseUrl, child } = await startCloudflaredTunnel({
    port: 1,
    binary: stubBinary({ registerOnDefault: true, registerOnHttp2: true }),
    ...FAST,
  })
  child.kill('SIGTERM')
  assert.equal(baseUrl, 'https://stub-quic.trycloudflare.com')
})

test('unregistered tunnel falls back to --protocol http2', async () => {
  const { baseUrl, child } = await startCloudflaredTunnel({
    port: 1,
    binary: stubBinary({ registerOnDefault: false, registerOnHttp2: true }),
    ...FAST,
  })
  child.kill('SIGTERM')
  assert.equal(baseUrl, 'https://stub-http2.trycloudflare.com')
})

test('failure on both transports throws with --public-base guidance', async () => {
  await assert.rejects(
    startCloudflaredTunnel({
      port: 1,
      binary: stubBinary({ registerOnDefault: false, registerOnHttp2: false }),
      ...FAST,
    }),
    /could not register with the edge on either transport/
  )
})
