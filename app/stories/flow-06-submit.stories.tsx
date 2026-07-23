import type { Meta, StoryObj } from '@storybook/react-vite'

/**
 * The Submit panel's copy states. All markup here is a static fixture: the
 * live rows read from submit state that is too entangled to lift without a
 * refactor (see the parked note in the story report). Copy is verbatim from
 * app.tsx so a wording change there must be mirrored here.
 */
function SubmitPanel({ children, rows }: { children?: React.ReactNode; rows?: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-no is-current">05</span>
        <h2>Submit</h2>
        <span className="panel-note">
          One on-chain commit per copy, signed by the session key without further prompts.
        </span>
      </div>
      {children}
      {rows != null && (
        <div className="table">
          <div className="trow thead submit-row">
            <span>Copy</span>
            <span>Provider</span>
            <span>Status</span>
            <span>Data set</span>
          </div>
          {rows}
        </div>
      )}
    </section>
  )
}

const meta = {
  title: 'Flow/06 Submit',
  component: SubmitPanel,
} satisfies Meta<typeof SubmitPanel>

export default meta
type Story = StoryObj<typeof meta>

/** Two copies committing: one pulling with an estimate, one confirming. */
export const Committing: Story = {
  args: {
    children: (
      <p className="gate-note">
        Providers pull and confirm on their own. Closing this tab only pauses new submissions. Progress is saved, and
        Resume continues exactly where it stopped.
      </p>
    ),
    rows: (
      <>
        <div className="trow submit-row">
          <span className="dim">primary</span>
          <span className="mono dim">ezpdpz</span>
          <span className="working">chunk 2/4 · provider pulling pieces… · about 3 minutes left</span>
          <span className="mono dim">#412 · 64 pieces</span>
        </div>
        <div className="trow submit-row">
          <span className="dim">secondary</span>
          <span className="mono dim">#88</span>
          <span className="working">confirming on chain…</span>
          <span className="mono dim">0x1f9a8c02…44e1</span>
        </div>
      </>
    ),
  },
}

/** The receipt stage: every copy committed, the wrap-up points at revocation. */
export const Done: Story = {
  args: {
    children: (
      <p className="gate-note">
        Every copy is committed. Revoke the signing session above once you are done migrating.
      </p>
    ),
    rows: (
      <>
        <div className="trow submit-row">
          <span className="dim">primary</span>
          <span className="mono dim">ezpdpz</span>
          <span className="ok-text">committed</span>
          <span className="mono dim">
            #412 · 128 pieces{' '}
            <button className="btn small" type="button">
              Verify on chain
            </button>
          </span>
        </div>
        <div className="trow submit-row">
          <span className="dim">secondary</span>
          <span className="mono dim">#88</span>
          <span className="ok-text">committed</span>
          <span className="mono dim">
            #97 · 128 pieces{' '}
            <button className="btn small" type="button">
              Verify on chain
            </button>
          </span>
        </div>
      </>
    ),
  },
}

/** One provider failed its copy; the error is the status cell. */
export const CopyFailed: Story = {
  args: {
    rows: (
      <div className="trow submit-row">
        <span className="dim">secondary</span>
        <span className="mono dim">#88</span>
        <span className="err-text">provider rejected the pull: staged piece expired</span>
        <span className="mono dim">—</span>
      </div>
    ),
  },
}

/** Pieces the provider could not fetch: the manifest handoff to the local path. */
export const DeferredHandoff: Story = {
  args: {
    children: (
      <div className="gate-note">
        <p>
          3 pieces were skipped: the provider could not fetch them from their source after retries (the "check
          availability" links above show why). Everything else committed. If the source recovers, or you host the bytes
          another way, retry here; otherwise the remainder manifest carries them to the local path. If any of these were
          already stored in this data set (an earlier run, another tool), click Verify on chain in the provider row
          above: anything the chain already holds is removed from this list.
        </p>
        <div className="actions">
          <button className="btn small" type="button">
            Retry the skipped pieces
          </button>
          <button className="btn small" type="button">
            Download manifest of the skipped pieces
          </button>
        </div>
      </div>
    ),
  },
}
