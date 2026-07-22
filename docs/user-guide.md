# User guide: migrating your pins

You have CIDs pinned somewhere on IPFS — a pinning service, your own node, a
gateway you trust — and you want the same content stored on Filecoin Onchain Cloud (FOC), paid for
on chain and covered by ongoing possession proofs. ipfs2foc moves it without re-chunking: each CID
you put in stays byte-for-byte intact, keeps its original CID, and remains
retrievable over IPFS after the migration. The end state is not a dashboard
claim; you verify it against the chain itself.

This guide picks the right path for your inventory and walks it end to end.
It assumes nothing beyond a list of CIDs.

## Pick your path

- **[Hosted console](browser-console.md)** at
  [filozone.github.io/ipfs2foc](https://filozone.github.io/ipfs2foc/) — runs
  in the tab, nothing to install, wallet key material never enters the page.
  The console enforces a per-run limit on CID count and total size and shows
  the current limit at the input; when your inventory is over it, the console
  points you at the paths below.
- **[Local console](local-console.md)** — the same app served by
  `ipfs2foc serve` on your machine: local cores and disk, runs that survive a
  closed tab, and packing for items below the provider's minimum piece size.
- **[Headless CLI](../README.md#quickstart)** — signs with a `PRIVATE_KEY`
  environment variable for automation and bulk runs that should not involve a
  browser at all.

A run moves between paths through the [run
manifest](browser-console.md#what-a-run-produces): prepare in one place,
submit in another.

## A hosted run, start to finish

1. **Load your CIDs.** Paste them, or drop a `cids.txt` file (one CID per
   line; blank lines and `#` comments are ignored) onto the input. The
   console reports what it accepted and which lines it rejected before
   anything runs.
2. **Prepare.** The console fetches each CID's blocks, checks every block
   hash, and computes the piece commitment the provider will later verify
   against — see [how the commitment is
   computed](browser-console.md#how-the-commitment-is-computed). A CID that
   cannot be retrieved completely shows a per-row error instead of a wrong
   commitment.
3. **Set up payment and signing.** The wallet panel walks the three one-time
   requirements: USDFC deposited into Filecoin Pay, the storage service
   approved as a payments operator, and a signing session — one wallet
   approval for a temporary key scoped to creating data sets and adding
   pieces, nothing else. Details in [submitting from the
   browser](browser-console.md#submitting-from-the-browser).
4. **Submit and watch.** Pick how many provider copies you want and press
   Submit. Providers pull the bytes directly; the status table tracks each
   copy from pull to committed data set. Refreshing the tab is safe — the run
   resumes where it stopped and never submits the same thing twice.
5. **Verify on chain.** "Verify on chain" reads a public RPC and answers the
   only question that matters: which pieces the data set actually holds, and
   whether the provider's latest accepted proof covers them. See [verifying
   against the chain](browser-console.md#verifying-against-the-chain).
6. **Save the manifest.** "Download run manifest" captures the run —
   commitments and pull URLs — as JSON. It is your portable record and the
   hand-off if you continue anywhere else.

## When the inventory is large

Over the hosted console's per-run limit, or facing a run measured in hours,
move to your own machine:

- `ipfs2foc serve` runs the [local console](local-console.md): same
  interface, but preparation uses your cores, state lives in a SQLite
  database, and submission keeps going after the tab closes.
- The [CLI quickstart](../README.md#quickstart) runs the whole pipeline
  headless: `plan` → `pdp-submit` → `report`. Runs are resumable by design —
  every step records its state in the database, re-running `plan` computes
  only what is missing, and interrupted submissions pick up where they
  stopped rather than re-adding anything.
- A run started in the hosted console carries over:
  `ipfs2foc import-manifest manifest.json` records the console's commitments
  without recomputing them, and `ipfs2foc export` writes a manifest back out
  for the reverse trip.

For sizing a large run — disk, bandwidth, and time budgets mapped to concrete
flags — see [operator profiles](personas.md).

## Verifying the end state

Trust the chain, not a status page. Two tools read it directly:

- The CLI's `ipfs2foc report` reconciles your local run state against the
  data set's on-chain pieces and flags anything missing.
- The consoles' "Verify on chain" does the same for a browser run, with no
  wallet or payment setup required.

A committed piece is stored; ongoing possession is proven separately, on a
roughly daily cadence. [How a migration lands on chain](onchain.md) explains
the invariants behind both checks and what "committed" does and does not
mean.

## Where to go next

- Rehearse on the testnet first: [your first migration on
  calibration](tutorial-first-migration.md).
- Term you have not met? The [glossary](glossary.md) defines every protocol
  word this documentation uses.
- Choosing a source gateway, and what "deterministic trustless CAR" means in
  practice: [sources](sources.md).
