import type { RunLimits } from '../run-limits.ts'
import { fmtLimitBytes } from './format.ts'

/**
 * The landing statement: what the tool does, then the fit check before any
 * wallet step. The caps come from run-limits so this line cannot drift from
 * the enforced numbers; a capless deployment (serve) drops the cap sentence.
 */
export function Lede({ limits }: { limits: RunLimits | null }) {
  return (
    <>
      {/* Each sentence is its own block, so the line break is fixed rather
          than set by the viewport width. */}
      <h1 className="lede">
        <span>Move pinned IPFS content to Filecoin.</span>
        <em>The CID does not change.</em>
      </h1>
      <p className="lede-sub">
        Point this at content you already have pinned. A storage provider fetches each item, stores it as the original
        DAG, and commits it on chain, so every link you have published keeps resolving and you can prove the content
        landed. Items served whole by a public gateway migrate here in the browser;{' '}
        <a href="https://github.com/FilOzone/ipfs2foc#readme" rel="noreferrer" target="_blank">
          the command line tool
        </a>{' '}
        covers the rest.
      </p>
      <p className="lede-sub">
        {limits != null &&
          `A run here handles up to ${limits.maxCids.toLocaleString()} items, ${fmtLimitBytes(limits.maxBytes)} total. `}
        You need a browser wallet extension holding USDFC (pays for storage) and a little FIL (pays gas). Preparation is
        free. You see the cost before connecting anything. Bigger sets run from your machine with the CLI:{' '}
        <code className="mono">npm i -g ipfs2foc</code>
      </p>
    </>
  )
}
