#!/usr/bin/env bash
#
# Scripted funded-wallet rehearsal on calibration (FilOzone/ipfs2foc#62).
#
# Runs the migrate.md agent flow end to end against the CLI *source* in this
# checkout, so unreleased changes are what gets rehearsed: probe -> analyze ->
# payments status -> upload -> report. Every stage prints a checkpoint; the
# script exits non-zero at the first stage that fails.
#
# Needs: Node 24+, a calibration wallet exported as PRIVATE_KEY and funded
# with calibration FIL and USDFC (run
# `npx filecoin-pin@latest payments setup --auto --network calibration` once),
# and a small list of public CIDs.
#
# Usage:
#   PRIVATE_KEY=0x... scripts/rehearse-calibration.sh --cids cids.txt [--keep]
#
#   --cids <file>   one CID per line; keep it small, this spends testnet funds
#   --gateway <url> source gateway (default https://trustless-gateway.link)
#   --keep          keep the work directory (db + staged CARs) after a pass;
#                   it is always kept after a failure

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $REPO_ROOT/packages/cli/src/cli.ts"
GATEWAY="https://trustless-gateway.link"
CIDS_FILE=""
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --cids) CIDS_FILE="$2"; shift 2 ;;
    --gateway) GATEWAY="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "REHEARSAL FAIL: $1" >&2; exit 1; }
stage() { printf '\n== %s\n' "$1"; }

# --- Stage 0: preconditions -------------------------------------------------
stage "stage 0: preconditions"
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 24 ] || fail "Node 24+ required (found $(node -v))"
[ -n "${PRIVATE_KEY:-}" ] || fail "export PRIVATE_KEY (0x + 64 hex) for a funded calibration wallet"
[ -n "$CIDS_FILE" ] || fail "--cids <file> is required"
[ -s "$CIDS_FILE" ] || fail "$CIDS_FILE is empty"
cid_count=$(grep -cve '^\s*$' -e '^\s*#' "$CIDS_FILE" || true)
first_cid=$(grep -ve '^\s*$' -e '^\s*#' "$CIDS_FILE" | head -1)
echo "ok: node $(node -v), $cid_count CID(s), first: $first_cid"
$CLI --version >/dev/null || fail "CLI does not run from source"

WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/ipfs2foc-rehearsal-XXXXXX")
DB="$WORKDIR/migrate.db"
CARS="$WORKDIR/cars"
echo "workdir: $WORKDIR"

# --- Stage 1: probe ---------------------------------------------------------
stage "stage 1: probe (deterministic CAR from $GATEWAY)"
$CLI probe "$first_cid" --gateway "$GATEWAY" || fail "probe: $GATEWAY is not a usable source for $first_cid"

# --- Stage 2: analyze -------------------------------------------------------
stage "stage 2: analyze (every listed CID retrievable)"
$CLI analyze --cids "$CIDS_FILE" --gateway "$GATEWAY" --all --network calibration --json \
  > "$WORKDIR/analyze.json" || fail "analyze exited non-zero; see $WORKDIR/analyze.json"
node -e "
  const r = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))
  const probes = r.sourceGateway.probes
  const bad = probes.filter((p) => !(p.ok && p.deterministic))
  if (bad.length > 0) {
    console.error(\`\${bad.length} of \${probes.length} probed CID(s) failed on the gateway; first: \${bad[0].cid}\`)
    process.exit(1)
  }
  console.log(\`ok: \${probes.length}/\${probes.length} probed CID(s) deterministic\`)
" "$WORKDIR/analyze.json" || fail "analyze probes failed; see $WORKDIR/analyze.json"

# --- Stage 3: payments ------------------------------------------------------
stage "stage 3: payments status (informational; upload fails clearly if unfunded)"
npx --yes filecoin-pin@latest payments status --network calibration || \
  fail "payments status errored; fund the wallet and run payments setup first"

# --- Stage 4: upload --------------------------------------------------------
stage "stage 4: upload (pack, store to providers, batched on-chain adds)"
$CLI upload --cids "$CIDS_FILE" --db "$DB" --car-store "$CARS" \
  --gateway "$GATEWAY" --network calibration || fail "upload exited non-zero; workdir kept at $WORKDIR"

data_set_ids=$(node -e "
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(process.argv[1])
  const rows = db.prepare('SELECT DISTINCT data_set_id FROM uploads WHERE data_set_id IS NOT NULL').all()
  console.log(rows.map((r) => r.data_set_id).join(' '))
" "$DB")
[ -n "$data_set_ids" ] || fail "no data set ids recorded in $DB"
echo "ok: data set(s): $data_set_ids"

# --- Stage 5: report --------------------------------------------------------
stage "stage 5: report (reconcile every piece against chain state)"
overall=0
for id in $data_set_ids; do
  out="$WORKDIR/report-$id.json"
  # --allow-unaccounted: synapse reuses the wallet's existing data set per
  # provider, so a rehearsal wallet's set may hold pieces from earlier runs.
  # Those are warned about below, not treated as a failed rehearsal.
  $CLI report --db "$DB" --data-set-id "$id" --network calibration --json --allow-unaccounted > "$out" \
    || fail "report exited non-zero for data set $id"
  node -e "
    const r = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))
    const problems = []
    if (r.cids.committed !== r.cids.total) problems.push(\`committed \${r.cids.committed}/\${r.cids.total}\`)
    if (r.discrepancies.length > 0) problems.push(\`\${r.discrepancies.length} discrepancies\`)
    if (problems.length > 0) { console.error('data set ' + process.argv[2] + ': ' + problems.join('; ')); process.exit(1) }
    if (r.unaccountedOnChain.length > 0) console.log('note: data set ' + process.argv[2] + ' holds ' + r.unaccountedOnChain.length + ' piece(s) from outside this run (reused data set); not a rehearsal failure')
    if (!r.proof.provenSinceAdd) console.log('note: data set ' + process.argv[2] + ' not yet proven since the add; proof lags a proving period, re-run report later to confirm')
    console.log('ok: data set ' + process.argv[2] + ': ' + r.cids.committed + '/' + r.cids.total + ' committed, no discrepancies')
  " "$out" "$id" || overall=1
done
[ "$overall" -eq 0 ] || fail "report found problems; JSON kept under $WORKDIR"

# --- Done -------------------------------------------------------------------
stage "REHEARSAL PASS"
echo "every stage checkpointed; reports under $WORKDIR"
if [ "$KEEP" -eq 0 ]; then
  rm -rf "$WORKDIR"
  echo "workdir removed (pass --keep to retain it)"
fi
