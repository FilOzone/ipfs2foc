import type { Meta, StoryObj } from '@storybook/react-vite'
import { CidCapNotice, InvalidCidNote } from '../src/components/notices.tsx'
import { CIDS, HOSTED_LIMITS } from './fixtures.ts'

/**
 * The CID intake panel. The textarea and buttons here are a static fixture
 * (the live panel's handlers are wired inside app.tsx); the notices under it
 * are the real components the app renders.
 */
function IntakePanel({
  value,
  uniqueCount,
  children,
}: {
  value: string
  uniqueCount: number
  children?: React.ReactNode
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <span className={`panel-no ${uniqueCount > 0 ? 'is-current' : ''}`}>02</span>
        <h2>CIDs</h2>
        <span className="panel-note">{uniqueCount === 0 ? '' : `${uniqueCount.toLocaleString()} unique`}</span>
      </div>
      <label className="input-label" htmlFor="cids">
        The CIDs you want on Filecoin
      </label>
      <textarea
        className="cid-input"
        id="cids"
        placeholder={'bafybei…\nQm…  (CIDv0 or CIDv1, one per line)\nor drop a cids.txt file here'}
        readOnly
        spellCheck={false}
        value={value}
      />
      {children}
      <div className="file-intake">
        <span className="btn small">Load cids.txt</span>
      </div>
      <div className="actions">
        <button className="btn primary" disabled={uniqueCount === 0} type="button">
          {uniqueCount === 0 ? 'Prepare' : `Prepare ${uniqueCount.toLocaleString()} items`}
        </button>
      </div>
    </section>
  )
}

const meta = {
  title: 'Flow/02 Intake',
  component: IntakePanel,
} satisfies Meta<typeof IntakePanel>

export default meta
type Story = StoryObj<typeof meta>

/** Nothing pasted yet: the placeholder carries the format guidance. */
export const Empty: Story = {
  args: { value: '', uniqueCount: 0 },
}

/** A clean paste. */
export const ValidPaste: Story = {
  args: { value: CIDS.join('\n'), uniqueCount: CIDS.length },
}

/** Lines that do not parse as CIDs are called out immediately, not at Prepare. */
export const InvalidLines: Story = {
  args: {
    value: `${CIDS[0]}\nnot-a-cid\nhello world\n${CIDS[1]}`,
    uniqueCount: 2,
    children: <InvalidCidNote invalid={['not-a-cid', 'hello world']} />,
  },
}

/** Over the hosted cap: the steer names the exact count and the CLI command. */
export const OverCap: Story = {
  args: {
    value: `${CIDS.join('\n')}\n… 498 more lines`,
    uniqueCount: 501,
    children: <CidCapNotice count={501} limits={HOSTED_LIMITS} />,
  },
}
