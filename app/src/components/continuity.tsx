import { short } from './format.ts'

export function Led({ on, color }: { on: boolean; color: string }) {
  return <span className="led" style={{ background: on ? color : 'transparent', borderColor: color }} />
}

/**
 * One prepared item, shown as the same CID on both sides of the move.
 *
 * The pieces table pairs each CID with its PieceCID, which reads as a
 * transformation. It isn't one: the PieceCID is the commitment Filecoin proves
 * against, while the CID that addresses the content is unchanged and stays
 * retrievable. This states that directly for the item in hand — the fact the
 * rest of the run depends on.
 */
export function Continuity({
  cid,
  pieceCid,
  size,
  drawn,
}: {
  cid: string
  pieceCid: string
  size: string
  drawn: boolean
}) {
  return (
    <div className="continuity">
      <div className="continuity-ends">
        <span className="side">
          <span className="side-label">On IPFS today</span>
          <code className="side-cid">{short(cid, 12, 8)}</code>
        </span>
        <span aria-hidden className={`continuity-rule ${drawn ? 'rule-draw' : ''}`} />
        <span className="side side-dest">
          <span className="side-label">On Filecoin</span>
          <code className="side-cid">{short(cid, 12, 8)}</code>
        </span>
      </div>
      <p className="continuity-note">
        Same CID, both sides. Filecoin proves it holds <code className="mono">{short(pieceCid, 10, 6)}</code>, the{' '}
        {size} commitment over those exact bytes.
      </p>
    </div>
  )
}
