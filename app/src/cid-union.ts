/**
 * Union of pasted and file-loaded CIDs, deduped on the canonical CIDv1 form
 * so `Qm...` pasted and its `bafy...` re-encoding loaded from a file count
 * once. First occurrence wins and keeps its input spelling, matching the
 * file intake (`packages/core/src/cid-list.ts` createCidCollector). Strings
 * that do not parse as CIDs dedupe on their raw text; the prepare pass
 * rejects them with a visible error, so dropping them here would hide that.
 */

import { toCanonicalCidV1 } from 'ipfs2foc-core'

export function dedupeCanonical(candidates: Iterable<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const candidate of candidates) {
    const key = toCanonicalCidV1(candidate) ?? candidate
    if (seen.has(key)) continue
    seen.add(key)
    out.push(candidate)
  }
  return out
}
