# Migrate with the local console

`ipfs2foc serve` runs the same console as the hosted site, backed by a local
daemon that does the heavy work: it computes commitments server-side, packs
aggregates, serves pieces to providers, and — once you grant it a signing
session — submits on chain by itself. The browser is a control plane; the tab
can close mid-run.

```bash
ipfs2foc serve --db migrate.db --ingress cloudflared --network calibration
# open http://localhost:4321
```

The console detects which backend it is talking to on load (`GET
/api/capabilities`): served from the daemon it shows the local control plane,
on the hosted site it falls back to the in-browser flow. One app, two
backends.

## Hosted or local?

Start hosted. The [hosted console](browser-console.md) needs no install and
covers the common case: passthrough pieces, commitments computed in the tab,
provider pulls through the shared relay.

Move to the local console when a run outgrows the tab:

- **Small items** — providers enforce a minimum piece size (typically 1 MiB
  padded), and the hosted passthrough flow commits one piece per CID.
  `pack-cars` groups small items into multi-root CARs above the minimum, and
  the local daemon byte-serves them to the provider.
- **Scale** — server-side commP uses the machine's cores and disk, not a
  browser tab that must stay open. State lives in a SQLite file, so the run
  survives reboots and resumes from where it stopped.
- **Assembled pieces** — multi-asset CARs (`pack-cars`) can only be
  byte-served from disk; the daemon's `/piece` endpoint does that, the relay
  cannot.
- **Long submits** — the daemon drives provider pull/add for hours without a
  browser. Extending the signing session in the console keeps a running
  submit going (the daemon re-checks the grant on chain).

Stay with the [headless CLI](../README.md#commands) for automation: cron-style
bulk runs sign with `PRIVATE_KEY` and need no browser at all.

A run is portable across all three. The [run
manifest](browser-console.md#what-a-run-produces) moves prepared pieces
between the hosted console and a local DB (`import-manifest` / `export`), and
the local console and the headless CLI share the same `migrate.db`.

## Running it

`serve` owns one migration database (default `./migrate.db`) and prints the
console URL on start. Everything the old terminal workflow did is in the
console: paste CIDs, press Start, watch counts, aggregates, and
failures update; pause, resume, and retry from the same panel. The runner
honors `--gateway`, `--piece-size`, `--concurrency`, and the IPFS fallback
flags exactly like `plan` — see the [command
reference](../README.md#commands).

The default network is mainnet; pass `--network calibration` for the testnet.
The selected network is printed at startup and reported to the console, which
refuses to sign against a wallet on a different chain.

## Provider ingress

Providers pull pieces from `{public-base}/piece/{pieceCidv2}`, which the
daemon serves directly (302 to the source gateway for passthrough pieces,
bytes from disk for assembled ones). That URL must be publicly reachable:

- `--ingress cloudflared` spawns a Cloudflare quick tunnel and self-checks it.
- `--public-base https://<host>` if you front the serve port yourself
  (Tailscale Funnel, a VPS reverse proxy — see [ingress](ingress.md)).

The console's *pieces* chip shows the public URL and whether it currently
answers; the daemon re-checks every minute and again at the moment you press
Submit, because a dead tunnel fails provider pulls silently.

## Signing without PRIVATE_KEY

The Signing panel connects a wallet and grants a session key: one wallet
transaction authorizing a temporary key for creating data sets and adding
pieces — nothing else — for a window you pick (24 hours to 7 days). The key
is handed to the daemon, which verifies the grant on chain and keeps it in
the migration database so a daemon restart resumes without re-granting.

The wallet needs the same one-time payment setup as the hosted flow (USDFC
deposited into Filecoin Pay, the storage service approved as a payments
operator); the panel reports both and links the setup guide.

Three controls cover the key's whole life:

- **Extend** re-authorizes the same key for a new window — one wallet
  transaction. Do this any time; a running submit picks the new expiry up
  from the chain and keeps going. The daemon stops issuing new
  authorizations in the last hour before expiry, so the console nudges well
  before that.
- **Revoke** ends the authorization on chain, then deletes both copies of
  the key. After the transaction confirms, nothing the key signed but the
  provider has not yet landed will be accepted.
- **Send to daemon** re-sends the browser's copy when the daemon lost its
  own (a fresh database, for example). No wallet transaction.

What the key can and cannot do, and where each copy lives, is specified in
[SECURITY.md](../SECURITY.md).

## Submitting

Once aggregates are packed, the Submit panel takes a data set id and starts
the run; the daemon presigns, points the provider at its own `/piece`
endpoint, and lands each aggregate's on-chain add. Progress is the Aggregates
table — the same `submitted → parked → committed` lifecycle as
`pdp-submit`, with the same at-most-once guarantee and chain reconciliation
on resume.

No data set yet? The panel creates one from a provider id, signed by the same
session. Data set ids are reusable across runs.

The submit button stays disabled until its prerequisites hold, and a refusal
names the missing one: a signing session, a reachable piece endpoint, or a
previous job still running. A run interrupted by anything — daemon restart,
session expiry, provider error — resumes from the database on the next
Submit; nothing is signed or added twice.

## When something breaks

The aggregate lifecycle, failure states, and recovery commands are the same
as the headless flow: see [recover a stuck
run](../README.md#recovery-commands) and the failure-mode sections in
[operator profiles](personas.md). The `serve` daemon and the recovery
commands operate on the same database file.
