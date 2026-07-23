/**
 * The steer notices: every place the console tells a user their input or run
 * has crossed a boundary and what to do about it. Kept as plain-prop
 * components so the copy is reviewable in isolation (Storybook) and rendered
 * from exactly one place.
 */

import type { ReactNode } from 'react'
import { trackOnce } from '../analytics.ts'
import type { RunLimits } from '../run-limits.ts'
import { fmtLimitBytes, short } from './format.ts'

/** Where a user with needs this console does not cover reaches a person. */
export const CONTACT_URL = 'https://filecoin.cloud/contact'

/**
 * The contact path, rendered wherever a boundary copy offers it. Click
 * tracking rides the same hosted-only analytics gate as everything else.
 */
export function ContactLink({ children = 'talk to us' }: { children?: ReactNode }) {
  return (
    <a href={CONTACT_URL} onClick={() => trackOnce('contact')} rel="noreferrer" target="_blank">
      {children}
    </a>
  )
}

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
      <code className="mono">npm i -g ipfs2foc</code>. Different requirements? <ContactLink>Talk to us</ContactLink>.
    </p>
  )
}

/** The byte-ceiling notice during prepare: the run filled one piece's worth. */
export function ByteCapNotice({ limits }: { limits: RunLimits }) {
  return (
    <p aria-live="polite" className="err-text">
      Prepared items reached this console&apos;s {fmtLimitBytes(limits.maxBytes)} per-run ceiling (the most one run can
      ship), so the rest of the list stayed queued. Migrate what is prepared, or run the full list from your machine
      with the CLI: <code className="mono">npm i -g ipfs2foc</code>. Different requirements?{' '}
      <ContactLink>Talk to us</ContactLink>.
    </p>
  )
}

/**
 * The long-run note: the live estimate projects past the advisory threshold.
 * Non-blocking; the run keeps going. `minutes` is the current projection, or
 * null when the estimate has gone quiet since the note latched.
 */
export function LongRunAdvisory({ minutes }: { minutes: number | null }) {
  return (
    <p aria-live="polite" className="gate-note">
      {minutes == null
        ? 'This run is pacing past ten minutes here.'
        : `This run looks like about ${minutes.toLocaleString()} minutes here.`}{' '}
      Leaving it open is fine, and it resumes if the tab closes. The CLI handles long migrations better, with more
      sources and longer retries: <code className="mono">npm i -g ipfs2foc</code>. Different requirements?{' '}
      <ContactLink>Talk to us</ContactLink>.
    </p>
  )
}

/** The failure rollup over the pieces table after a finished run. */
export function FailureSummary({ errors, total }: { errors: number; total: number }) {
  return (
    <p aria-live="polite" className="err-text">
      {errors.toLocaleString()} of {total.toLocaleString()} item{total === 1 ? '' : 's'} could not be fetched here.
      Retry below once the source settles, try another gateway under Sources, and for persistent failures run these from
      the CLI, which pulls from more sources with longer retries: <code className="mono">npm i -g ipfs2foc</code>. If
      these need another path entirely (private sources, very large assets), <ContactLink>talk to us</ContactLink>.
    </p>
  )
}
