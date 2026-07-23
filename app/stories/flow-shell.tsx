/**
 * The one-active-step flow layout for stories: the real HistoryChrome beside
 * a single active panel, exactly as app.tsx composes it. Stories pass the
 * completed entries and the active stage; the chrome picks rail or rows by
 * viewport, same stylesheet, same switch.
 */

import { HistoryChrome } from '../src/components/history-chrome.tsx'
import type { HistoryEntry, Stage } from '../src/flow.ts'
import { noop } from './fixtures.ts'

export function FlowShell({
  active,
  entries,
  children,
}: {
  active: Stage
  entries: HistoryEntry[]
  children: React.ReactNode
}) {
  return (
    <div className={`flow${entries.length === 0 ? ' no-hist' : ''}`}>
      <HistoryChrome active={active} entries={entries} onPeek={noop} peek={null} />
      <div className="flow-main">{children}</div>
    </div>
  )
}
