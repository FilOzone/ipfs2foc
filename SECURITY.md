# Security

ipfs2foc signs on-chain transactions and spends real funds. This document
covers how it handles the signing key, what that key can authorize, and how to
report a vulnerability.

## Reporting a vulnerability

Report privately through GitHub's
[security advisories](https://github.com/SgtPooki/ipfs2foc/security/advisories/new)
for this repository. Do not open a public issue for an exploitable flaw. Expect
an initial response within a few days.

## The signing key

`create-data-set` and `pdp-submit` read the signer from the `PRIVATE_KEY`
environment variable (`0x` + 64 hex). The key is passed to viem's
`privateKeyToAccount` and used to sign locally; it is not written to the SQLite
database (the schema stores only CIDs, piece commitments, and aggregate
lifecycle — see [State](README.md#state)) and the tool does not print it. Only
the resulting signatures and signed transactions leave the process.

Operator guidance:

- **Use a dedicated migration wallet.** Fund it with only the FIL and USDFC a
  run needs. A migration key does not need to hold long-term reserves.
- **Keep the key out of shell history and version control.** Prefer
  `source .env` from a file that is in `.gitignore`, or a secrets manager, over
  inlining the key on the command line.
- **Scope by network.** The default network is `mainnet`, which spends real
  funds. Rehearse a run end-to-end with `--network calibration` first.

## What the key authorizes

The same key signs every step, so anyone holding it can spend on the migrator's
behalf:

- **FIL** from the migrator's wallet for its own setup transactions: the USDFC
  ERC-20 approve, the FilecoinPay deposit, and the FilecoinWarmStorageService
  operator approval.
- **USDFC** committed as storage payment. `create-data-set` opens a payment rail
  and locks the minimum lockup plus a one-time sybil fee; AddPieces raises the
  locked amount as the data set grows.
- **EIP-712 authorizations** carried in each call's `extraData`. The storage
  provider submits and pays FIL gas for createDataSet, AddPieces, and proof of
  possession; the migrator's signature authorizes them. See
  [Network gas and payments](README.md#network-gas-and-payments).

## Session keys

The browser consoles (hosted and local) never see `PRIVATE_KEY`. They sign
with a session key instead: a fresh secp256k1 key the wallet authorizes on
chain with one transaction, scoped to exactly two operations — creating data
sets and adding pieces — and an explicit expiry the operator picks (24 hours
to 7 days, extendable in place). It cannot move funds, remove pieces, or
delete data sets; spending limits still come from the wallet's USDFC deposit
and operator approval. Revoking it (one transaction, from the console) ends
the authorization for anything a provider has not already landed.

Where the key material lives:

- **Hosted console** — encrypted at rest in the browser's IndexedDB, keyed to
  the wallet and network. Browser storage is not a defense against someone
  with access to the OS profile; the on-chain scope, expiry, and revocation
  are the real controls.
- **Local console** (`serve`) — the browser hands the key to the daemon over
  the loopback connection, and the daemon stores it in the migration database
  so an interrupted submit resumes after a restart. The daemon verifies the
  grant on chain before accepting, never logs the key, and never returns it
  from any API. Treat a `migrate.db` with an unexpired session like the
  scoped credential it contains: `DELETE /api/session` (or the console's
  Revoke) removes it.

The `serve` API binds 127.0.0.1 and rejects requests whose Host or Origin is
not local, so neither a public tunnel in front of `/piece` nor a foreign web
page reaches the session endpoints.

## Data handling

ipfs2foc streams each object once to compute its piece commitment and stores no
payload bytes. The SQLite database holds CIDs, piece commitments, the aggregate
plan, per-aggregate lifecycle (data set id, transaction hash), and — for the
local console only — the scoped session key described above. The
`redirect-serve` HTTP server answers 302 redirects to gateway CARs (passthrough
sub-pieces) or byte-serves assembled CAR files (multi-asset sub-pieces) from
`--car-store`; it carries no key material.
