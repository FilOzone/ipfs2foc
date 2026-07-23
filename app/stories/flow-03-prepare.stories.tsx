import type { Meta, StoryObj } from '@storybook/react-vite'
import { Continuity } from '../src/components/continuity.tsx'
import { ByteCapNotice, FailureSummary, LongRunAdvisory } from '../src/components/notices.tsx'
import { PieceRow, type PieceRowView } from '../src/components/piece-row.tsx'
import {
  CIDS,
  HOSTED_LIMITS,
  noop,
  PIECE_CIDS,
  ROW_DONE,
  ROW_DONE_GAP_FILLED,
  ROW_FAILED,
  ROW_QUEUED,
  ROW_WORKING,
} from './fixtures.ts'
import { FlowShell } from './flow-shell.tsx'

/**
 * The Pieces panel while prepare owns the main column. Rendered inside the
 * real flow layout: the history chrome (rail wide, receipt rows narrow)
 * carries the completed List step. The panel chrome and filter chips are a
 * static fixture; every row, notice, and the chrome are the real components.
 */
function PreparePanel({
  note,
  rows,
  errOpen = false,
  running = false,
  children,
  continuity = false,
  reviewGate = 0,
}: {
  note: string
  rows: PieceRowView[]
  errOpen?: boolean
  running?: boolean
  children?: React.ReactNode
  continuity?: boolean
  reviewGate?: number
}) {
  return (
    <FlowShell active="prepare" entries={[{ stage: 'intake', label: 'Listed 500 items' }]}>
      <section className="panel">
        <div className="panel-head">
          <span className={`panel-no ${running ? 'is-current' : 'is-done'}`}>02</span>
          <h2>Pieces</h2>
          <span className="panel-note">{note}</span>
        </div>
        {children}
        {continuity && <Continuity cid={CIDS[0]} drawn={running} pieceCid={PIECE_CIDS[0]} size="4.44 MiB" />}
        <div className="table">
          <div className="trow thead">
            <span>Your CID</span>
            <span>Commitment</span>
            <span className="num">Size</span>
            <span>Source the provider reads</span>
          </div>
          {rows.map((view) => (
            <PieceRow
              copied={false}
              errOpen={errOpen}
              key={`${view.cid}-${view.phase}`}
              onCancel={noop}
              onCopy={noop}
              onRetry={noop}
              onToggleError={noop}
              running={running}
              view={view}
            />
          ))}
        </div>
        {reviewGate > 0 && (
          <>
            <div className="actions">
              <button className="btn primary" type="button">
                Review cost ({reviewGate.toLocaleString()} items)
              </button>
            </div>
            <p className="gate-note">Next: review cost, then approve in wallet.</p>
          </>
        )}
      </section>
    </FlowShell>
  )
}

const meta = {
  title: 'Flow/03 Prepare',
  component: PreparePanel,
} satisfies Meta<typeof PreparePanel>

export default meta
type Story = StoryObj<typeof meta>

/** Mid-run: the live rate and time estimate ride in the panel note. */
export const InProgress: Story = {
  args: {
    note: '212 ready · 3.2/s · about 2 minutes left',
    rows: [ROW_DONE, ROW_WORKING, ROW_QUEUED],
    running: true,
    continuity: true,
  },
}

/** Every row state at once: ready, gap-filled, working, failed, queued. */
export const RowStates: Story = {
  args: {
    note: '2 ready · 1 failed',
    rows: [ROW_DONE, ROW_DONE_GAP_FILLED, ROW_WORKING, ROW_FAILED, ROW_QUEUED],
  },
}

/** A failed row with its full error expanded. */
export const FailureExpanded: Story = {
  args: {
    note: '0 ready · 1 failed',
    rows: [ROW_FAILED],
    errOpen: true,
  },
}

/** The finished-run failure rollup: counts, options, CLI steer. */
export const WithFailureSummary: Story = {
  args: {
    note: '497 ready · 3 failed',
    rows: [ROW_DONE, ROW_FAILED],
    children: <FailureSummary errors={3} total={500} />,
    reviewGate: 497,
  },
}

/** The run finished clean: the gate to the cost step and the roadmap line. */
export const ReviewGate: Story = {
  args: {
    note: '500 ready',
    rows: [ROW_DONE, ROW_DONE_GAP_FILLED],
    reviewGate: 500,
  },
}

/** The run hit the hosted byte ceiling; the remainder stays queued. */
export const ByteCapReached: Story = {
  args: {
    note: '312 ready',
    rows: [ROW_DONE, ROW_QUEUED],
    children: <ByteCapNotice limits={HOSTED_LIMITS} />,
  },
}

/** The live estimate projects past ten minutes; the run keeps going. */
export const LongRunProjected: Story = {
  args: {
    note: '38 ready · 0.8/s · about 40 minutes left',
    rows: [ROW_DONE, ROW_WORKING, ROW_QUEUED],
    children: <LongRunAdvisory minutes={40} />,
    running: true,
  },
}
