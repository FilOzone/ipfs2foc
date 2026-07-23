import { fmtBytes, short } from './format.ts'

/** The view of one prepare row, shaped from the store state by the caller. */
export type PieceRowView =
  | { phase: 'done'; cid: string; pieceCid: string; rawSize: number; sourceUrl: string; gapFillCount: number }
  | { phase: 'error'; cid: string; message: string; detail: string }
  | { phase: 'working'; cid: string; bytes: number; rate: number }
  | { phase: 'queued'; cid: string }

export interface PieceRowProps {
  view: PieceRowView
  running: boolean
  copied: boolean
  errOpen: boolean
  onToggleError: () => void
  onCopy: () => void
  onRetry: () => void
  onCancel: () => void
}

/** One row of the pieces table: the CID, its commitment state, and the row's action. */
export function PieceRow({ view, running, copied, errOpen, onToggleError, onCopy, onRetry, onCancel }: PieceRowProps) {
  return (
    <div className="trow">
      <code className="mono dim" title={view.cid}>
        {short(view.cid)}
      </code>
      {view.phase === 'done' ? (
        <span className="piece">
          <code className="mono" title={view.pieceCid}>
            {short(view.pieceCid)}
          </code>
          {view.gapFillCount > 0 && (
            <span
              className="warn"
              title={`Gateway served an incomplete CAR. ${view.gapFillCount} block(s) recovered per-block. The provider pulls the CAR URL, so re-verify this gateway before submitting; if its CAR is still incomplete at pull time the on-chain AddPieces will fail.`}
            >
              ⚠ incomplete CAR
            </span>
          )}
        </span>
      ) : view.phase === 'error' ? (
        <span className="err-text">
          <button
            className="err-toggle"
            onClick={onToggleError}
            title={errOpen ? 'hide the full error' : 'show the full error'}
            type="button"
          >
            {short(view.message, 44, 0)}
          </button>{' '}
          <a
            href={`https://check.ipfs.network/?cid=${view.cid}`}
            rel="noreferrer"
            target="_blank"
            title="probe this CID's providers and retrievability on the public network"
          >
            check availability
          </a>
          {errOpen && <span className="err-detail mono">{view.detail}</span>}
        </span>
      ) : view.phase === 'working' ? (
        <span className="working">
          ▍ {fmtBytes(view.bytes)}
          {view.rate > 0 ? ` · ${view.rate.toFixed(1)} MiB/s` : ''}
        </span>
      ) : (
        <span className="dim">queued</span>
      )}
      <span className="num mono dim">{view.phase === 'done' ? fmtBytes(view.rawSize) : '—'}</span>
      {view.phase === 'done' ? (
        <>
          <button className="copy" onClick={onCopy} type="button">
            {copied ? 'copied ✓' : 'copy'}
          </button>
          {view.gapFillCount > 0 && (
            <button
              className="copy"
              disabled={running}
              onClick={onRetry}
              title="Refetch this root; a run with a complete stream clears the hold on submit."
              type="button"
            >
              retry
            </button>
          )}
        </>
      ) : view.phase === 'error' ? (
        <button className="copy" disabled={running} onClick={onRetry} type="button">
          retry
        </button>
      ) : view.phase === 'working' ? (
        <button className="copy" onClick={onCancel} type="button">
          cancel
        </button>
      ) : (
        <span className="dim">—</span>
      )}
    </div>
  )
}
