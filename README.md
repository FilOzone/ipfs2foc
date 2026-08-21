# ipfs2foc

[![npm version](https://img.shields.io/npm/v/ipfs2foc.svg)](https://www.npmjs.com/package/ipfs2foc)
[![Node](https://img.shields.io/node/v/ipfs2foc.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Migrate already-pinned IPFS CIDs onto Filecoin Onchain Cloud (FOC) without re-chunking.

Each original CID stays byte-for-byte intact and individually retrievable over
IPFS. One command owns the migration: `upload` downloads each CID's CAR from a
[trustless IPFS gateway](docs/glossary.md#trustless-gateway), packs small
objects into ~1 GiB multi-root CAR pieces, streams every piece straight to the
storage providers, and batches the on-chain adds. No public origin, tunnel, or
relay is needed, and staged CARs are deleted as each piece's copies commit, so
the disk footprint stays near the pack target rather than the size of the
migration.

New here? Start with the [user guide](docs/user-guide.md): it picks the
right path for your inventory and walks a migration end to end.

To migrate a small list with nothing installed, use the
[browser console](docs/browser-console.md) at
[filozone.github.io/ipfs2foc](https://filozone.github.io/ipfs2foc/). When a
run outgrows the tab, `ipfs2foc serve` runs the same console against a
[local daemon](docs/local-console.md); headless automation uses the
[CLI commands](#commands) directly.

## Contents

- [Install](#install)
- [Requirements](#requirements)
- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [Commands](#commands)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Network gas and payments](#network-gas-and-payments)
- [State](#state)
- [Scope and limits](#scope-and-limits)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Install

```bash
npm install -g ipfs2foc      # the `ipfs2foc` command
# or run without installing:
npx ipfs2foc --help
```

Installs report coarse, anonymized package-usage data (operating system,
package version; no stored IP or personal data) through
[@scarf/scarf](https://www.npmjs.com/package/@scarf/scarf) to help us see
whether the tool is reaching people. Each CLI command also reports one
anonymous run event (the command name and whether it succeeded, nothing else).
Opt out of both with `SCARF_ANALYTICS=false` or `DO_NOT_TRACK=1` in your
environment; `npm install --ignore-scripts` additionally skips the
install-time report.

The hosted web console reports usage signals (page views, funnel steps such
as "entered CIDs" or "run completed" with coarse count buckets, and the step
a closed tab was on) and error reports with CIDs and wallet addresses
redacted before anything is sent. Only the production deployment on its
official domains reports; a `serve` daemon, a development build, or a
self-hosted copy of the static site sends nothing.

From source (development uses [pnpm](https://pnpm.io)):

```bash
git clone https://github.com/FilOzone/ipfs2foc
cd ipfs2foc
pnpm install
node packages/cli/src/index.ts --help   # run directly; Node strips the TypeScript types
```

## Requirements

- **Node 24+** (uses the built-in `node:sqlite`).
- A source that serves **deterministic trustless CARs**. The default is
  `trustless-gateway.link`; others (for example `gateway.pinata.cloud`) work via
  `--gateway`. A gateway that returns reassembled files instead of CARs does
  not work; `probe` reports which case a gateway falls into. See
  [`docs/sources.md`](docs/sources.md) for per-provider notes and probe
  commands.

## Prerequisites

Before running the quickstart, complete the one-time wallet setup on the network
you target (default `mainnet`; pass `--network calibration` for the testnet).

- **Wallet**: a wallet whose address is the FWSS payer for the data sets the
  run creates. Export the key as `PRIVATE_KEY` (`0x` + 64 hex) in the
  environment. The same key signs the data-set creation and every AddPieces
  submission.
- **FIL** in that wallet for the migrator's own transactions: USDFC ERC-20 approve,
  FilecoinPay deposit, FilecoinWarmStorageService operator approval. These three
  steps happen once per payer; the storage provider pays gas for everything it
  submits on chain (createDataSet, AddPieces, proof of possession).
- **Payment setup**: deposit USDFC into Filecoin Pay and approve FWSS as a
  payments operator with enough rate and lockup allowance, plus the minimum
  lockup and one-time sybil fee. On-chain commits revert without it.
  [`filecoin-pin`](https://github.com/filecoin-project/filecoin-pin)
  ([getting started](https://docs.filecoin.io/build-on-filecoin/cookbook/filecoin-pin/getting-started))
  does the deposit and approvals in one command:

  ```bash
  export PRIVATE_KEY=0x...
  npx filecoin-pin@latest payments setup --auto    # add --network calibration for the testnet
  npx filecoin-pin@latest payments status          # confirm the approvals and balance
  ```

  The [Synapse SDK](https://github.com/FilOzone/synapse-sdk) `Payments` helper
  exposes the same calls directly, and PDP Scan (`https://pdp.vxb.ai/{network}`)
  shows the resulting account state.
- **Trustless gateway**: confirm the gateway you intend to use returns
  byte-stable CARs for one of your CIDs with `probe` before migrating.

Providers are chosen automatically; pin specific ones with `--provider-id`
(ids at `https://pdp.vxb.ai/{network}/providers`) only if you have a reason to.

## Quickstart

Complete **Prerequisites** above first. Default network is **mainnet**; pass
`--network calibration` for the testnet.

> **First time?** Rehearse the whole flow on the testnet with the
> [calibration tutorial](docs/tutorial-first-migration.md) before spending real
> funds on mainnet.

```bash
export PRIVATE_KEY=0x...

# One-time payer setup: deposit USDFC and approve FWSS as a payments operator.
npx filecoin-pin@latest payments setup --auto

# 1. Confirm a trustless gateway returns a deterministic CAR for one of your CIDs.
ipfs2foc probe <sample-cid> --gateway https://trustless-gateway.link

# 2. Migrate: download the CIDs, pack ~1 GiB multi-root CARs under --car-store,
#    stream each straight to two providers, and batch the on-chain adds before
#    the provider's parked-piece GC window closes. Resumable; re-run to continue.
#    Data sets are provisioned on first commit (withIPFSIndexing set); their ids
#    are in the printed summary.
printf '%s\n' <cid> > cids.txt
ipfs2foc upload --cids cids.txt --db migrate.db --car-store ./cars

# 3. Confirm every CID landed: reconcile local state against the on-chain pieces.
ipfs2foc report --db migrate.db --data-set-id <data-set-id>
```

`cids.txt`: one CID per line; blank lines and `#` comments are ignored.

`upload` needs no public origin, tunnel, or relay: the client uploads once to
the primary provider and each secondary pulls its copy from the primary.
Staged CARs are deleted as soon as every copy is committed, so the disk
footprint stays near `--pack-target-size`, not the size of the migration.

Hosting the pieces yourself and having the provider pull them is still
possible; that older flow lives in
[`docs/advanced.md`](docs/advanced.md) and is more complicated than most
migrations need.

## Commands

```bash
# Check whether a gateway serves deterministic CARs for a CID
ipfs2foc probe <cid> [--gateway https://gateway.pinata.cloud]...

# Compute one PieceCID v2
ipfs2foc commp <cid> [--gateway URL]...

# Pre-flight a CID list against a gateway: pass rate, sizes, throughput estimate
ipfs2foc analyze [--cids cids.txt] [--db migrate.db] [--car-store <dir>] [--gateway URL] \
  [--sample 100|--all] [--probe-concurrency 8] [--bw-target URL] \
  [--network mainnet|calibration] [--json]

# Migrate (PRIVATE_KEY env): download, pack multi-root CARs, stream each
# straight to the providers, and batch addPieces before the provider's
# parked-piece GC window closes. No public origin, relay, or ingress required.
ipfs2foc upload [--cids cids.txt] --car-store <dir> [--db migrate.db] [--gateway URL]... \
  [--network mainnet|calibration] [--rpc-url URL] [--copies 2] \
  [--provider-id <id>]... [--data-set-id <id>]... \
  [--pack-target-size 1000MiB] [--concurrency 8] [--fetch-concurrency 4] \
  [--assumed-window-minutes 60]

# Progress and per-piece status
ipfs2foc status [--db migrate.db] [--json]

# Verification report: reconcile a run against the data set's on-chain pieces
ipfs2foc report --db migrate.db --data-set-id <id> \
  [--network mainnet|calibration] [--rpc-url URL] [--json] \
  [--check-ipni <delegated-routing-url>] [--ipni-sample 100|--ipni-all] [--ipni-concurrency 8]

# Background daemon + browser console (start/pause/resume, add CIDs, add gateways)
ipfs2foc serve [--db migrate.db] [--cids cids.txt] [--gateway URL]... \
  [--port 4321] [--network mainnet|calibration] [--rpc-url URL] [--max-base-fee N] \
  [--app-dir <dir>]

# Current network base fee and whether to pause submission
ipfs2foc gas [--network mainnet|calibration] [--rpc-url URL] [--max-base-fee 1000000]

# Installed version
ipfs2foc --version
```

`commp` and `serve` also accept an opt-in IPFS fallback that recovers from
source-gateway 5xx/429 through an embedded node:

```bash
[--ipfs-fallback] [--ipfs-fallback-mode gateway-first] [--ipfs-fallback-timeout-seconds 120]
```

The legacy provider-pull commands (`plan`, `pack-cars`, `import-manifest`,
`redirect-serve`, `pdp-submit`, `create-data-set`, and the aggregate recovery
commands) are documented in [`docs/advanced.md`](docs/advanced.md).

### Console

`serve` starts an HTTP server (default `http://localhost:4321`) that runs the commP pass
in the background and serves the bundled [browser console](docs/browser-console.md) as
its control plane: live piece counts, per-piece status, and failures. Controls: start,
pause, resume, retry failed, add CIDs (`POST /api/cids`), set gateways
(`POST /api/gateways`). All state lives in the DB, so the process can stop and resume.

The console asks `GET /api/capabilities` on load to discover what the backend can do;
the hosted copy of the same app gets a 404 there and falls back to its in-browser
prepare + signing flow. The server binds loopback only and rejects cross-origin
mutations. During development, point `serve` at a freshly built console with
`--app-dir ../../app/dist` or the `IPFS2FOC_APP_DIR` environment variable (build it
with base `/`, the way `pnpm -C packages/cli build` does; a GitHub Pages build uses
a different base path and will not load).

The console can also submit on chain without `PRIVATE_KEY`: connect a wallet in the
Signing panel and grant a session key (one wallet transaction, scoped to
CreateDataSet + AddPieces with an explicit expiry). The daemon verifies the grant on
chain, keeps the key in the migration database, and drives the submission itself:
the tab can close mid-run, and extending the session in the browser keeps a
long run going without restarting it. The stored key signs nothing beyond those two
operations and can be revoked from the console at any time; treat the `.db` file
like the working state it is.

## Troubleshooting

- **`probe` reports `WARN`.** The gateway answered but the bytes do not re-hash
  to the requested CID, or the response is not a CAR. That gateway cannot be a
  source. Fix the gateway config (Kubo: set `Gateway.DeserializedResponses` to
  `false`) or pick another from [`docs/sources.md`](docs/sources.md).
- **`set PRIVATE_KEY (0x + 64 hex)`.** Commands that sign read the key from the
  environment. Export it (`export PRIVATE_KEY=0x...`) or `source .env` before
  running.
- **On-chain commits revert.** The payer's USDFC deposit, FWSS operator
  approval, or allowances are insufficient. See [Prerequisites](#prerequisites).
- **An item fails as too large.** A single CID whose CAR exceeds the provider's
  per-piece limit (~1 GiB raw) cannot be migrated; re-chunking is unsupported.
  Hold it out of the run.
- **`collected:` lines during `upload`.** A provider garbage-collected a parked
  piece before it was committed; the run re-uploads it automatically and
  tightens its commit timing for that provider. Informational, not a failure.
- **Submission pauses on `spike`.** The network base fee is above
  `--max-base-fee`. Submission waits out the congestion; check with
  `ipfs2foc gas`.

[`docs/personas.md`](docs/personas.md) covers per-profile failure modes (gateway
flakes, disk pressure, idle-timeout cascades) and recovery.

## How it works

1. **commP pass.** For each CID, fetch its CAR (`?format=car&dag-scope=all`) from a
   trustless gateway and stream it through the Filecoin piece hasher to get its
   [**PieceCID v2**](docs/glossary.md#piececid-v2) ([FRC-0069](docs/glossary.md#frc-0069)).
   The CAR is rooted at the original CID, so storing it keeps the CID intact, and
   the CAR root is checked against the requested CID.
2. **Pack.** Bin-pack small CARs into multi-root CAR pieces up to
   `--pack-target-size` (default 1000 MiB) under `--car-store`, so far fewer
   pieces are committed on chain than there are CIDs.
3. **Store.** Stream each piece to the primary provider, which verifies its
   CommP against the declared PieceCID and parks it; each secondary provider
   copies the piece from the primary. No public origin, tunnel, or relay.
4. **Commit.** Batch the on-chain AddPieces before the provider's parked-piece
   GC window closes. Data sets are provisioned automatically on the first
   commit with [`withIPFSIndexing`](docs/glossary.md#withipfsindexing) set, so
   the provider indexes each parked CAR's blocks and every original CID stays
   retrievable from the IPFS network by the same CID.

The run is resumable at every stage: re-running the same command continues
where it stopped, never re-uploads what is already committed, and never
double-commits. Staged CARs are deleted as each piece's copies are all
committed.

## Network gas and payments

Two wallets spend on a migration, in different currencies.

The **storage provider** submits and pays the FIL gas for the on-chain transactions in
this flow: data set creation, AddPieces, and the recurring proof-of-possession
transactions. The migrator authorizes each by an EIP-712 signature carried in the call's
`extraData`, and the provider sends the transaction.

The **migrator** is the data set's [FWSS](docs/glossary.md#filecoinwarmstorageservice-fwss) payer and spends both currencies:

- **USDFC** for storage. Data set creation opens a payment rail from the migrator to the
  provider and requires the migrator to have deposited enough USDFC to cover the minimum
  lockup plus a one-time sybil fee; AddPieces raises the rail's locked amount as the data
  set grows. See `FilecoinWarmStorageService.dataSetCreated` / `piecesAdded` in
  [filecoin-services](https://github.com/FilOzone/filecoin-services).
- **FIL** for the migrator's own setup transactions, sent from the migrator's wallet:
  approving USDFC to the [FilecoinPay](docs/glossary.md#filecoinpay) contract, depositing USDFC, and approving
  [FilecoinWarmStorageService](docs/glossary.md#filecoinwarmstorageservice-fwss) as a payments operator with sufficient rate and lockup
  allowance.

Filecoin gas cost scales with the block base fee, and PDP transactions burn a large
amount of gas, so network congestion multiplies the provider's cost. The `gas` command
reads the latest block base fee (attoFIL/gas; floor 100) and reports a level: `ok`,
`rising`, or `spike`. Above `--max-base-fee` (default 1,000,000) the level is `spike`
and submission waits out the congestion.

## State

State lives in the SQLite database (`migrate.db` by default): each CID's piece
commitment and status, the packed piece it belongs to, and the per-piece,
per-provider upload lifecycle (parked, committed, data set id, transaction
hash). A run resumes from here; re-running computes only CIDs that are not yet
`done` and retries failures. Tables: `pieces`, `sub_pieces`,
`sub_piece_members`, `uploads`, plus `aggregates` and `aggregate_members` for
the [legacy pull path](docs/advanced.md).

## Scope and limits

- The source must serve deterministic trustless CARs. Use `probe` to check.
- **Per-item size**: each CID's CAR must be within the provider's piece limit
  (~1 GiB raw). Larger items cannot be migrated until re-chunking is supported;
  they are reported, never silently dropped.
- **Pack target**: `--pack-target-size` (default 1000 MiB) bounds each packed
  piece; items above the target that fit the provider limit ship as their own
  piece.
- **Determinism**: the migration stores the exact bytes the gateway served for
  each CID, and every provider copy carries the same piece commitment. A
  gateway that serves different bytes across requests fails `probe` and cannot
  be a source.

## Documentation

The [`docs/`](docs/README.md) folder is organized by [Diátaxis](https://diataxis.fr/):

- **[User guide](docs/user-guide.md)**: pick a path (hosted console, local
  console, CLI) and walk a migration end to end.
- **Tutorial**: [your first migration on calibration](docs/tutorial-first-migration.md),
  one CID end-to-end with a checkpoint at every step.
- **How-to**: [the hosted console](docs/browser-console.md),
  [the local console](docs/local-console.md), [operator profiles](docs/personas.md)
  (disk/bandwidth/time budgets to knob settings, failure modes, recovery),
  [choosing a gateway](docs/sources.md).
- **Reference**: [command reference](#commands) and [glossary](docs/glossary.md).
- **Explanation**: [how a migration lands on chain](docs/onchain.md) (the
  invariants for integrators), [how it works](#how-it-works),
  [gas and payments](#network-gas-and-payments), [scope and limits](#scope-and-limits).
- **Advanced**: [the legacy provider-pull path](docs/advanced.md): self-hosted
  pull sources, aggregates, public ingress ([`docs/ingress.md`](docs/ingress.md)),
  and the relay.

## Contributing

Issues and pull requests welcome at
[github.com/FilOzone/ipfs2foc](https://github.com/FilOzone/ipfs2foc). See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the dev loop and conventions, and
[`SECURITY.md`](SECURITY.md) for key-handling and on-chain-spend guidance.

## License

[MIT](LICENSE)
