# Prepare migrations in the browser

The hosted console at
[sgtpooki.github.io/ipfs2foc](https://sgtpooki.github.io/ipfs2foc/) runs the
prepare step of a passthrough migration entirely in the tab: paste CIDs, get
back each one's PieceCID v2, size, and the pull URL a storage provider
follows. Nothing to install, no key material on the page — the wallet step is
read-only and signs nothing.

## What a run produces

For each CID, the console computes the piece commitment and builds the pull
URL through the stateless redirect relay. The "Download run manifest" button
saves the whole run as JSON — the per-piece commitments and pull URLs, plus
the gateway and relay they were computed against. Wallet-signed submission
from the browser is the next slice of
[#23](https://github.com/SgtPooki/ipfs2foc/issues/23); importing a manifest
into the CLI for submission is
[#35](https://github.com/SgtPooki/ipfs2foc/issues/35).

## How the commitment is computed

The console does not hash a gateway response. It retrieves the DAG
block-by-block (each block hash-checked against its CID), serializes the
canonical trustless CAR locally, and hashes that. The result is byte-identical
to the CAR the provider later pulls — the same guarantee the CLI pins in its
regression suite — and a gateway that returns an incomplete DAG produces a
loud per-row error instead of a wrong commitment.

CIDv0 (`Qm…`) input is normalized to CIDv1 before anything is fetched, so the
committed bytes and the pull URL always use one canonical form.

## Interruptions

Run state persists in the browser. Refreshing or reopening the tab restores
the CID list and finished rows; rerunning Prepare recomputes only what is
missing. Clear starts over.

## When to use the CLI instead

Bulk runs, assembled (multi-asset) pieces, and submission with a headless key
stay with the [CLI](../README.md). The browser console covers the
one-CID-one-piece passthrough case.
