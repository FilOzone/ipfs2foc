# Advanced: the legacy provider-pull path

`ipfs2foc upload` is the migration path; the [README quickstart](../README.md#quickstart)
covers it. This page documents the older flow it replaced, where the roles are
reversed: you host the pieces over public HTTPS and the storage provider pulls
them (`plan` → `redirect-serve` or `serve --ingress` → `pdp-submit`). It is more
complicated than most migrations need and every command in it requires the
explicit `--legacy-pull` flag.

Reach for this path only when one of these is true:

- You already operate public HTTPS infrastructure and want the provider to pull
  from your origin instead of receiving uploads.
- Your source gateway truncates whole-CAR streams, so pieces must be assembled
  locally (`pack-cars`) and served or streamed through the shared relay.
- You are submitting a run prepared in the browser console from its exported
  manifest (`import-manifest` + `pdp-submit --source-relay`).

## The flow

1. `plan` computes each CID's piece commitment and packs
   [sub-pieces](glossary.md#sub-piece) into aggregates in the SQLite DB.
2. `redirect-serve` (or `serve --ingress`) exposes a public
   `/piece/{pcidv2}` endpoint the provider can pull from.
3. `pdp-submit` asks the provider to pull each sub-piece, waits for it to park
   and verify them, and lands the aggregate AddPieces on chain.
4. `report` reconciles the run against the data set's on-chain pieces, the same
   as the upload path.

```bash
ipfs2foc plan --cids cids.txt --db migrate.db
ipfs2foc redirect-serve --db migrate.db --port 4322 --ingress cloudflared --legacy-pull
ipfs2foc pdp-submit --db migrate.db --data-set-id <data-set-id> \
  --source-base https://<public-host> --legacy-pull
```

`plan` is **INSERT-only**: re-running it after appending CIDs adds new
sub-pieces and aggregates without rewriting prior planning state. Existing
`submitted`/`parked`/`committed` aggregates are never touched.

[`personas.md`](personas.md) maps disk, bandwidth, and time budgets to concrete
knob settings for this path.

## Commands

```bash
# Full pipeline: commitments + aggregate packing into a SQLite DB.
# Default auto-wraps each source CID as a passthrough sub-piece. Pass
# --no-auto-pack to defer sub-piece assembly to `pack-cars` (multi-asset).
ipfs2foc plan --cids cids.txt [--db migrate.db] [--gateway URL]... \
  [--piece-size 32GiB] [--concurrency 8] [--no-auto-pack]

# Multi-asset packer: assemble many source CIDs into one multi-root CAR per
# sub-piece, append aggregates over the new sub-pieces.
ipfs2foc pack-cars --db migrate.db --car-store <dir> [--gateway URL]... \
  [--pack-target-size 512MiB] [--fetch-concurrency 4]

# Load a run manifest saved by the browser console: records its piece
# commitments as done pieces (recomputing nothing) and packs aggregates,
# leaving the DB as if `plan` had produced it. Refuses on network mismatch
# or a conflicting prior commitment; re-import is a no-op.
ipfs2foc import-manifest <manifest.json> [--db migrate.db] \
  [--network mainnet|calibration] [--piece-size 32GiB] [--no-auto-pack]

# Sub-piece server: GET /piece/{pcidv2} -> 302 to the gateway CAR for a
# passthrough sub-piece, or byte-serves the assembled CAR file for a
# multi-asset sub-piece.
ipfs2foc redirect-serve [--db migrate.db] [--port 4322] [--ingress funnel|cloudflared] --legacy-pull

# Provision a new FWSS data set with withIPFSIndexing (PRIVATE_KEY env).
# The upload path provisions data sets automatically; this command exists for
# the pull path and for pinning a specific provider by hand.
ipfs2foc create-data-set --provider-id <id> \
  [--network mainnet|calibration] [--rpc-url URL] [--cdn] [--timeout-seconds 600]

# Migrate via the PDP pull path (PRIVATE_KEY env). The pull source is either
# your own redirect-serve origin (--source-base) or a shared stateless relay
# (--source-relay, passthrough sub-pieces only, no server of your own needed).
ipfs2foc pdp-submit --db migrate.db --data-set-id <id> \
  (--source-base https://<public-host> | --source-relay https://<relay-base>) \
  [--network mainnet|calibration] [--rpc-url URL] \
  [--max-in-flight 4] [--max-base-fee 1000000] [--pull-batch 32] [--poll-seconds 15] \
  --legacy-pull
```

`plan` also accepts the opt-in IPFS fallback flags
(`--ipfs-fallback`, `--ipfs-fallback-mode gateway-first`,
`--ipfs-fallback-timeout-seconds 120`) to recover from source-gateway 5xx/429
through an embedded node.

`serve` carries the same `/piece/{pcidv2}` route, so one process can host the
console and the pull source: pass `--ingress cloudflared` or front the port
yourself and pass `--public-base https://<host>`, plus `--legacy-pull`.

`pdp-submit` honors the in-flight cap, the base-fee gate, and provider pull
backpressure (HTTP 429 + `Retry-After`). If the provider's add errors after the
on-chain AddPieces already landed, `pdp-submit` confirms the aggregate against
the data set's active pieces and marks it committed instead of adding it again.

## Submitting a browser-console run

A run prepared in the [browser console](browser-console.md) submits through
this path: `import-manifest` the saved manifest, then `pdp-submit
--source-relay`. The provider pulls each piece through the relay, so no
redirect server of your own is needed.

## Aggregate lifecycle and park/commit safety

Each aggregate moves through `planned` → `submitted` → `parked` → `committed`
(or `failed`). `parked` means the provider has downloaded and verified every
sub-piece but nothing is on-chain yet. `pdp-submit` caps the count of
aggregates at `submitted`/`parked` that have not reached `committed`
(`--max-in-flight`), so a provider is not asked to download far more than is
then committed, and it pauses when the network base fee is above
`--max-base-fee`.

Repacking touches only `planned` aggregates. Once an aggregate is `submitted`
or beyond, its index and members are frozen, and its CIDs are excluded from
future packing.

## Why the redirect, and the PieceCID up front

A provider's PDP pull admits source URLs shaped `/piece/{pieceCidV2}`, and it
follows cross-origin redirects (re-validating scheme and public host). A
`/piece/{pcidv2}` endpoint that 302s to `/ipfs/{cid}?format=car` lets the
provider pull the CAR straight from the gateway. Since Curio v1.28.3 the pull
also accepts a plain HTTPS gateway CAR URL directly, which is what removed the
relay from the browser flow; the redirect shape remains for this self-hosted
path. The provider verifies pulled bytes against the PieceCID you supply, so
the commP pass runs regardless.

## Aggregate root

The aggregate root is the
[**aggregate piece commitment**](glossary.md#aggregate-piece-commitment): the
trunc-254 merkle of the sub-piece commitments, largest-first, zero-padded to
the next power of two. The same value is recomputed by Curio
(`commputils.PieceAggregateCommP`, `go-commp-utils`) on add.
`packages/core/src/piece-aggregate.ts` computes it locally so the on-chain add
validates; the add rejects a mismatched root, so a successful commit confirms
the local computation. This value is verified byte-for-byte against
`go-commp-utils` in `test/`.

## Public ingress for provider pulls

`redirect-serve` needs a public HTTPS URL resolving to a public IP. Two
built-in paths:

- `--ingress cloudflared` spawns a Cloudflare quick tunnel
  (`*.trycloudflare.com`). No account, works behind CGNAT, requires the
  `cloudflared` binary on PATH.
- `--ingress funnel` (default): you run the local HTTP server and front it
  yourself with Tailscale Funnel, Cloudflare Tunnel, or a VPS reverse proxy.

Setup details, prerequisites, and the public-HTTPS shape the provider
validates live in [`ingress.md`](ingress.md). Pass the **HTTPS origin only**
(scheme + host, no path) as `--source-base`.

## Recovery commands

These re-arm aggregates that did not reach `committed`. They are not part of a
routine migration; reach for them only when a run is stuck and you have read
[`personas.md`](personas.md) failure modes.

```bash
# Move `failed` aggregates back to `planned` so the next pdp-submit retries them
ipfs2foc reset-failed-aggregates [--db migrate.db] [--network mainnet|calibration]

# Re-arm `submitted`/`parked` aggregates that never confirmed.
# Only after verifying on chain that their roots are NOT present. Re-arming an
# aggregate whose AddPieces actually landed lands a duplicate.
ipfs2foc retry-unconfirmed-aggregates [--db migrate.db] [--network mainnet|calibration]
```

## Troubleshooting

- **Provider rejects the pull / public-host error.** `--source-base` must be
  the public HTTPS origin only (scheme + host, no path) and resolve to a public
  IP. CGNAT and private ranges are rejected. See [`ingress.md`](ingress.md).
- **`plan` reports a CID as `oversized`.** Its padded piece size exceeds the
  `--piece-size` aggregate budget. A CAR above the provider's per-piece pull
  limit (~1 GiB raw) cannot be migrated as one piece either; hold it out of the
  run until re-chunking is supported.
- **`pdp-submit` skips an aggregate: `sub-piece(s) below provider min piece size`.**
  In the single-asset path each source CID is its own sub-piece, and the
  provider enforces a minimum piece size (commonly 1 MiB). CIDs whose CAR pads
  below that floor cannot go through the passthrough path on that provider; use
  the multi-asset path (`plan --no-auto-pack` then `pack-cars
  --pack-target-size` at or above the provider minimum) to batch them into a
  large enough piece.
- **Submission pauses on `spike`.** The network base fee is above
  `--max-base-fee`. `pdp-submit` waits out the congestion; check with
  `ipfs2foc gas`.

## Limits specific to this path

- **Sub-pieces per pull request**: the pull admission `eth_call`-simulates
  AddPieces over the batch, and the PDPVerifier `PiecesAdded` event carries one
  piece CID per piece. The FVM caps a single actor event at 8192 bytes, so a
  pull batch of too many sub-pieces reverts admission. `pdp-submit` splits the
  pull into batches (`--pull-batch`, default 32), each with its own
  authorization. The on-chain aggregate-add stays one top-level piece, so the
  cap applies to the pull batch, not to how many sub-pieces an aggregate holds.
- **Determinism**: the provider re-fetches the gateway CAR and recomputes
  CommP, so a byte difference is a permanent failure. `plan` pins one gateway
  origin and request shape per piece, and `redirect-serve` 302s to that exact
  URL.
- **All-or-nothing aggregate**: one unretrievable sub-piece fails its
  aggregate. The commP pass validates per-CID retrievability first.
