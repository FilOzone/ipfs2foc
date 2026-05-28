# Validate At Each Step

**Trigger:** Writing code that flips a record from one state to another based on an external response (tx receipt, API status, webhook).

## Rule

- Validate state transitions inline at the moment they happen.
- Parse and store the structured evidence (event fields, on-chain ids, block numbers) on the row right then.
- Do not defer correctness checks to a final `report` or reconciliation pass.
- If the evidence does not parse, fail the transition; do not write a partial row.

## Examples

### Bad

```ts
// commit step: trust the status flag, move on
if (resp.ok) row.status = 'added'
// report step (hours later): try to figure out what actually happened
```

### Good

```ts
// commit step: parse PiecesAdded event, persist on-chain pieceId + block
const receipt = await provider.getTransactionReceipt(txHash)
const ev = parsePiecesAdded(receipt.logs)
if (!ev) throw new Error('PiecesAdded missing; refusing to mark added')
row.pieceId = ev.pieceId
row.addedAtBlock = receipt.blockNumber
row.status = 'added'
```

## Why

The blast radius of a silent-corruption bug grows with every step between the bad write and the check. Inline validation at the transition keeps the bad row from propagating into downstream batches, reports, and re-runs.
