import type { HistoryEntry, Stage } from '../flow.ts'
import { STAGE_TITLES } from '../flow.ts'

/**
 * Completed steps, melted out of the main column: one entry list rendered
 * into two containers — a slim sticky rail beside the active card on wide
 * screens, one-line receipt rows above it on narrow ones. The stylesheet
 * picks per viewport, so both renderings stay in sync by construction.
 *
 * Entries are live state, never a table of contents: future steps do not
 * appear. Clicking a completed entry peeks at that step's panel; clicking
 * the active entry (enabled only while peeking) returns to the current step.
 */
export function HistoryChrome({
  entries,
  active,
  peek,
  onPeek,
}: {
  entries: HistoryEntry[]
  active: Stage
  peek: Stage | null
  onPeek: (stage: Stage | null) => void
}) {
  if (entries.length === 0) return null
  const list = (
    <>
      {entries.map((e) => (
        <button
          aria-pressed={peek === e.stage}
          className={`hist-item${peek === e.stage ? ' is-peek' : ''}`}
          key={e.stage}
          onClick={() => onPeek(peek === e.stage ? null : e.stage)}
          title={`Show the ${STAGE_TITLES[e.stage]} step`}
          type="button"
        >
          <span aria-hidden className="mark">
            ✓
          </span>
          <span>{e.label}</span>
        </button>
      ))}
      <button
        className="hist-item is-active"
        disabled={peek == null}
        onClick={() => onPeek(null)}
        title={peek == null ? undefined : 'Back to the current step'}
        type="button"
      >
        <span aria-hidden className="mark">
          →
        </span>
        <span>{STAGE_TITLES[active]}</span>
      </button>
    </>
  )
  return (
    <>
      <nav aria-label="Migration steps completed" className="hist-rail">
        {list}
      </nav>
      <nav aria-label="Migration steps completed" className="hist-rows">
        {list}
      </nav>
    </>
  )
}
