/**
 * The steer notices: every place the console tells a user their input or run
 * has crossed a boundary and what to do about it. Kept as plain-prop
 * components so the copy is reviewable in isolation (Storybook) and rendered
 * from exactly one place.
 */

import type { RunLimits } from '../run-limits.ts'
import { short } from './format.ts'

/** Pasted lines that do not parse as CIDs, called out at intake time. */
export function InvalidCidNote({ invalid }: { invalid: string[] }) {
  if (invalid.length === 0) return null
  return (
    <p aria-live="polite" className="err-text">
      {invalid.length.toLocaleString()} entr{invalid.length === 1 ? 'y' : 'ies'} in the list{' '}
      {invalid.length === 1 ? 'is' : 'are'} not a valid CID:{' '}
      {invalid
        .slice(0, 3)
        .map((s) => `"${short(s, 24, 0)}"`)
        .join(', ')}
      {invalid.length > 3 ? ', …' : ''}. Fix or remove them; left in, they fail at Prepare.
    </p>
  )
}

/** The over-cap steer at intake: the list is bigger than a hosted run takes. */
export function CidCapNotice({ limits, count }: { limits: RunLimits; count: number }) {
  return (
    <p className="err-text">
      This hosted console handles up to {limits.maxCids.toLocaleString()} items per run; your list has{' '}
      {count.toLocaleString()}. For larger sets, run the same migration from your machine with the CLI:{' '}
      <code className="mono">npm i -g ipfs2foc</code>
    </p>
  )
}

/** The byte-cap notice during prepare: the run filled its size budget. */
export function ByteCapNotice({ limits }: { limits: RunLimits }) {
  return (
    <p aria-live="polite" className="err-text">
      Prepared items reached this console&apos;s {Math.round(limits.maxBytes / (1024 * 1024))} MiB per-run limit, so the
      rest of the list stayed queued. Migrate what is prepared, or run the full list from your machine with the CLI:{' '}
      <code className="mono">npm i -g ipfs2foc</code>
    </p>
  )
}

/** The failure rollup over the pieces table after a finished run. */
export function FailureSummary({ errors, total }: { errors: number; total: number }) {
  return (
    <p aria-live="polite" className="err-text">
      {errors.toLocaleString()} of {total.toLocaleString()} item{total === 1 ? '' : 's'} could not be fetched here.
      Retry below once the source settles, try another gateway under Sources, and for persistent failures run these from
      the CLI, which pulls from more sources with longer retries: <code className="mono">npm i -g ipfs2foc</code>
    </p>
  )
}
