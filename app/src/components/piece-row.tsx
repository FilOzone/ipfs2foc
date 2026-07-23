import { type PreparePhase, stallHint } from '../commp.ts'
import { fmtBytes, short } from './format.ts'

/** The view of one prepare row, shaped from the store state by the caller. */
export type PieceRowView =
  | { phase: 'done'; cid: string; pieceCid: string; rawSize: number; sourceUrl: string; gapFillCount: number }
  | { phase: 'error'; cid: string; message: string; detail: string }
  | { phase: 'working'; cid: string; bytes: number; rate: number; stalledIn?: PreparePhase }
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
      <code className="mono dim" data-label="CID" title={view.cid}>
        {short(view.cid)}
      </code>
      {view.phase === 'done' ? (
        <span className="piece" data-label="Piece">
          <code className="mono" title={view.pieceCid}>
            {short(view.pieceCid)}
          </code>
          {view.gapFillCount > 0 && (
            <span
              className="warn"
              title={`The gateway stream was missing ${view.gapFillCount} block(s); they were fetched from other sources and hash-verified, so this piece is correct. The provider pulls from the gateway at submit time, so retry this row (or switch gateway) until the stream is complete before storing.`}
            >
              ⚠ incomplete CAR
            </span>
          )}
        </span>
      ) : view.phase === 'error' ? (
        <span className="err-text" data-label="Status">
          <button
            aria-expanded={errOpen}
            className="err-toggle"
            onClick={onToggleError}
            title={errOpen ? 'hide the full error' : 'show the full error'}
            type="button"
          >
            {short(view.message, 44, 0)}
          </button>{' '}
          {view.message !== 'not a valid CID' && (
            <a
              href={`https://check.ipfs.network/?cid=${view.cid}`}
              rel="noreferrer"
              target="_blank"
              title="probe this CID's providers and retrievability on the public network"
            >
              check availability
            </a>
          )}
          {errOpen && <span className="err-detail mono">{view.detail}</span>}
        </span>
      ) : view.phase === 'working' ? (
        <span className="working" data-label="Status">
          ▍ {fmtBytes(view.bytes)}
          {view.rate > 0 ? ` · ${view.rate.toFixed(1)} MiB/s` : ''}
          {view.stalledIn != null && <span className="dim"> · {stallHint(view.stalledIn)}</span>}
        </span>
      ) : (
        <span className="dim" data-label="Status">
          queued
        </span>
      )}
      <span className="num mono dim" data-label="Size">
        {view.phase === 'done' ? fmtBytes(view.rawSize) : '—'}
      </span>
      {view.phase === 'done' ? (
        <span className="row-actions" data-label="Action">
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
        </span>
      ) : view.phase === 'error' ? (
        <button className="copy" data-label="Action" disabled={running} onClick={onRetry} type="button">
          retry
        </button>
      ) : view.phase === 'working' ? (
        <button className="copy" data-label="Action" onClick={onCancel} type="button">
          cancel
        </button>
      ) : (
        <span className="dim" data-label="Action">
          —
        </span>
      )}
    </div>
  )
}
