# ipfs2foc CAR relay

A **stateless** CAR relay for the in-browser BYOW migration dApp. It is the
shared, multi-tenant stand-in for the CLI's per-operator redirect server
(`packages/cli/src/redirect-server.ts`): a browser tab cannot accept the inbound
`/piece/{pieceCidV2}` pull a storage provider makes, so the dApp points the
provider at this relay, and the relay streams the canonical CAR the piece was
committed over.

The relay holds no state and stores nothing, but the CAR bytes do flow through
it: it opens one streaming `?format=car` request to the gateway, hash-verifies
every block, and re-serializes the canonical CARv1 (dfs, dups=n) to the
provider. Any block the gateway's CAR stream fails to deliver — truncation,
corruption, a 504 — is recovered with a per-block `?format=raw` fetch, so DAGs
the gateway can serve block-wise but not as one CAR are still pullable. The
output is byte-identical either way: the canonical serialization is the very
definition the piece commitment was computed over.

This replaced the original 302 redirect, whose one-shot gateway CAR fetch had
no recovery when the gateway truncated the stream.

## How it works — routing in the path

The dApp hands the provider a `sourceUrl` shaped:

```
https://<worker>.workers.dev/r/{gatewayHost}/{cid}/piece/{pieceCidV2}
```

Curio's pull validator (`pdp/pull_types.go#ValidatePullSourceURL`) only requires
the path to **end** with `/piece/{pieceCid}` (the regex is not start-anchored)
and the captured pieceCid to equal the on-chain value, over HTTPS to a public
host. So the dApp prepends `/r/{gatewayHost}/{cid}`, and the relay recovers the
gateway + CID from the prefix and streams the canonical CAR for that root —
sourced via the same `ipfs2foc-core` URL builders the migrator committed over.
`{pieceCidV2}` is only there to satisfy the suffix rule; the relay ignores it
(the provider verifies it).

`HEAD` on a valid pull path answers `200` with the CAR content type and no
body or upstream fetch. `GET /healthz` → `200`. Everything else → `404`.

## Why it is safe

- **No proxy-to-anywhere.** The relay never fetches a client-supplied URL.
  `{gatewayHost}` must be an **exact** member of the allowlist — a bare
  hostname matched literally, not a URL parsed for its `.hostname` — so ports,
  userinfo (`evil@host`), IDN homographs, and percent-escapes cannot smuggle a
  different target. Upstream URLs are built from the allowlist's own string.
- **Byte-safety.** `{cid}` must be a canonical CIDv1 (it round-trips to
  itself); the CID is the CAR root, so a re-encoded CID would mean different
  bytes and a different commP. Every block is verified against its CID before
  it is serialized, so a corrupt gateway frame can never reach the provider.
- **Strict, decode-free parsing.** Exactly six path segments; any `%` is
  rejected (valid hostnames and CIDv1s never need encoding); the path length is
  bounded.

Built-in allowlist: the hosts in `DEFAULT_GATEWAYS`
(`trustless-gateway.link`). Widen it by config via `ALLOWED_GATEWAY_HOSTS`
(comma-separated hostnames), not code.

### Failure semantics

- An unfetchable **root** (CAR stream and raw fetch both fail) answers `502`
  before any body bytes, so the provider records a clean failure.
- An unrecoverable block **mid-stream** errors the response stream; the
  provider sees a transport abort (never a clean-looking truncated CAR) and
  fails the pull at the body read, before commP.
- A rebuild that fired is logged (`rebuilt N block(s) via raw fetch for {cid}`)
  in Workers Logs; the gateway's CAR endpoint being unable to stream that DAG
  is worth reporting upstream.

### Operational notes

- **Workers Paid required.** Streaming and hash-verifying tens of MB per pull
  is well past the free plan's 10ms CPU budget (paid: 30s default, ~100×
  headroom; worst-case full per-block rebuild is hundreds of subrequests vs the
  10k paid limit).
- **Memory.** The reorder buffer and exporter lookahead are deliberately small
  (`handler.ts` `RELAY_MAX_BUFFERED_BLOCKS`/`RELAY_LOOKAHEAD`): a fast gateway
  feeding a slow provider must not buffer the DAG tail inside the 128MB
  isolate.
- **Abuse.** Because there is no registration step, anyone can craft a URL that
  streams a gateway CAR (the provider still re-verifies commP, so this is a
  bandwidth/ToS concern, not an integrity one). The per-IP rate limit on `/r/*`
  is configured in `wrangler.jsonc`; `observability` is enabled so pulls and
  rebuilds are visible in Workers Logs.
- **`*.workers.dev`** is blocked on some corporate/SP networks; a custom domain
  removes that and decouples the published `sourceUrl` from the CF account.

## Validate

1. **Unit** — `test/relay-worker.test.ts` (via the repo's `npm test`) drives the
   handler directly with injected fake gateway streams: byte-identity of the
   relayed CAR for healthy, truncated, and corrupt streams; the 502 root path;
   teardown on consumer cancel; and the adversarial cases (userinfo, port,
   look-alike, percent-encoding, CIDv0, arity, HEAD). No `wrangler`, no
   network.

2. **Real runtime, local** — `workerd` with no account needed (this also
   exercises the workerd bundle, whose sha2 implementation differs from
   Node's):

   ```sh
   cd packages/relay && npx wrangler dev --local --port 8788
   H=trustless-gateway.link
   CID=bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi
   PCID=bafkzcibdxzhqyefkufvnsmqlyrjyr3el6affnfo3l7ipfncjjzjl4hkaqhbaema3
   curl -sI "localhost:8788/r/$H/$CID/piece/$PCID"        # 200 + application/vnd.ipld.car
   curl -s "localhost:8788/r/$H/$CID/piece/$PCID" -o got.car
   curl -s "https://$H/ipfs/$CID?format=car&dag-scope=all&car-version=1&car-order=dfs&car-dups=n" -o want.car
   cmp got.car want.car                                    # byte-identical
   ```

3. **Full chain** — point the CLI's `pdp-submit --source-base` at a deployed
   relay against a real provider (calibration, #22). The provider pulls *through*
   the relay; no dApp needed to exercise the pull path. (Note: the CLI builds
   `{base}/piece/{pcid}` with a single base, so for the stateless shape the
   per-piece prefix is set by the dApp's submit, not the current CLI batch path.)

## Deploy

```sh
cd packages/relay
npx wrangler deploy            # provisions nothing — stateless
```

The Worker imports the canonical CAR exporter and stream source from
`ipfs2foc-core`; `wrangler` bundles them. No build step, no KV namespace.

## Scope

Passthrough migrations only (one source CID → one sub-piece). The assembled
multi-asset path needs byte-serving of operator-built CARs and stays with the
CLI. See issues #23 and #45.
