# Sample, Not Sweep, At Scale

**Trigger:** Adding a verify or audit command that walks per-asset rows.

## Rule

- Default to a stride sample. Gate the full sweep behind `--all`.
- Use deterministic stride: `offset = floor(i * total / sampleSize)` for `i in 0..sampleSize-1`.
- Print the sample size and stride so operators can reproduce the run.
- Do not parallelize sampling beyond what the source gateway can serve.

## Examples

### Bad

```ts
for (const row of db.prepare('SELECT cid FROM assets').iterate()) {
  await probe(row.cid) // 1M HTTP requests against the source gateway
}
```

### Good

```ts
const total = countAssets()
const n = args.all ? total : (args.sample ?? 100)
const step = total / n
for (let i = 0; i < n; i++) {
  const cid = cidAtOffset(Math.floor(i * step))
  await probe(cid)
}
```

## Why

A million-CID sweep over HTTP melts the source endpoint and any rate limit between. A stride sample with a fixed seed is reproducible across runs, so failures are debuggable.
