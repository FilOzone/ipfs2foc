# Prefer HEAD Over GET

**Trigger:** Any HTTP probe whose goal is "does this exist / what type is it" rather than "give me the bytes".

## Rule

- Use `HEAD` for existence checks and content-type sniffing.
- Reserve `GET` for cases where the body is consumed.
- Check `response.ok`, `response.status`, and `response.headers.get('content-type')` from the HEAD response.
- If the endpoint rejects HEAD, fall back to `GET` with a `Range: bytes=0-0` header before pulling the full body.

## Examples

### Bad

```ts
const res = await fetch(`${gateway}/ipfs/${cid}`)
if (!res.ok) return false
const buf = await res.arrayBuffer() // bytes discarded
return true
```

### Good

```ts
const res = await fetch(`${gateway}/ipfs/${cid}`, { method: 'HEAD' })
return res.ok && res.headers.get('content-type') !== null
```

## Why

A GET pulls the full payload across the wire and through the gateway's egress. HEAD returns the same status and headers without the body, so probes at scale do not melt the source gateway.
