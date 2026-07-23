import type { Meta, StoryObj } from '@storybook/react-vite'
import { FlowShell } from './flow-shell.tsx'

/**
 * The cost gate: price before any wallet interaction. Markup mirrors the
 * cost panel in app.tsx (a wording change there must be mirrored here); the
 * history chrome carries the completed List and Prepare steps.
 */
function CostPanel({
  strip,
  estimate,
  reading = false,
  rateError,
  count,
}: {
  strip: string
  estimate?: string
  reading?: boolean
  rateError?: string
  count: number
}) {
  return (
    <FlowShell
      active="cost"
      entries={[
        { stage: 'intake', label: 'Listed 500 items' },
        { stage: 'prepare', label: 'Prepared 497 of 500' },
      ]}
    >
      <section className="panel">
        <div className="panel-head">
          <span className="panel-no is-current">03</span>
          <h2>Cost</h2>
          <span className="panel-note">Read from the storage service. Nothing is signed here.</span>
        </div>
        <p className="gate-note">{strip}</p>
        <div className="actions">
          <span className="session-controls">
            <span className="copies-label">Copies</span>
            <select defaultValue={2}>
              <option value={1}>1 (single provider)</option>
              <option value={2}>2 (primary + secondary)</option>
              <option value={3}>3 (primary + two secondaries)</option>
            </select>
          </span>
        </div>
        {reading && <p className="gate-note">reading the current storage rate…</p>}
        {rateError != null && (
          <p className="err-text">
            The rate read failed: {rateError}. The wallet step shows balances before anything is signed.
          </p>
        )}
        {estimate != null && <p className="gate-note">{estimate}</p>}
        <div className="actions">
          <button className="btn primary" type="button">
            Continue with {count.toLocaleString()} items
          </button>
        </div>
        <p className="gate-note">Next: approve in wallet.</p>
      </section>
    </FlowShell>
  )
}

const meta = {
  title: 'Flow/04 Cost',
  component: CostPanel,
} satisfies Meta<typeof CostPanel>

export default meta
type Story = StoryObj<typeof meta>

const STRIP = '497 of 500 prepared · 3 need retry or the CLI'

/** The estimate from the live storage rate, before anything is signed. */
export const WithEstimate: Story = {
  args: {
    strip: STRIP,
    count: 497,
    estimate:
      'Estimated cost: ≈0.12 USDFC per month for 2 copies of 92.40 MiB, billed while the data set stays funded. The exact rate is fixed when the data set is created.',
  },
}

/** The rate read is still in flight when the gate first renders. */
export const ReadingRate: Story = {
  args: { strip: STRIP, count: 497, reading: true },
}

/** A failed rate read degrades to honest copy and never blocks the gate. */
export const RateFailed: Story = {
  args: { strip: STRIP, count: 497, rateError: 'RPC timeout after 10s' },
}
