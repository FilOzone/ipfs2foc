# Memory-Aware Scaling

**Trigger:** Writing code that operates over a per-asset or per-piece list.

## Rule

- Estimate the list size at operator scale before allocating it.
- At 1M+ CIDs a flat string array is hundreds of MB; do not hold it just to sample 100 entries.
- Use two-pass walks with bounded per-iteration buffers, or stride / reservoir sampling that materializes only the sample.
- Stream from the data source (SQL cursor, async iterator) instead of `SELECT *` into an array.

## Examples

### Bad

```ts
const allCids: string[] = db.prepare('SELECT cid FROM assets').all().map(r => r.cid)
const sample = pickN(allCids, 100)
```

### Good

```ts
// see src/report.ts collectSample
const total = db.prepare('SELECT COUNT(*) AS n FROM assets').get().n
const step = total / sampleSize
const sample: string[] = []
for (let i = 0; i < sampleSize; i++) {
  const offset = Math.floor(i * step)
  sample.push(db.prepare('SELECT cid FROM assets LIMIT 1 OFFSET ?').get(offset).cid)
}
```

## Why

Operator scale is not developer-laptop scale. Sampling at the SQL boundary keeps RSS flat regardless of input size.
