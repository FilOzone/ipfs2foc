import type { Meta, StoryObj } from '@storybook/react-vite'
import { ByteCapNotice, CidCapNotice, FailureSummary, InvalidCidNote } from '../src/components/notices.tsx'
import { NO_WALLET_MESSAGE } from '../src/wallet.ts'
import { HOSTED_LIMITS } from './fixtures.ts'

/**
 * Every steer message on one screen, for copy review in a single pass: the
 * places the console tells a user to fix input, move to the CLI, or that a
 * prerequisite is missing.
 */
function BoundariesGallery() {
  return (
    <div style={{ display: 'grid', gap: '1.5rem' }}>
      <div>
        <p className="panel-note">Intake: invalid lines</p>
        <InvalidCidNote invalid={['not-a-cid', 'hello world', 'bafybe', 'Qm']} />
      </div>
      <div>
        <p className="panel-note">Intake: over the item cap</p>
        <CidCapNotice count={2_159_085} limits={HOSTED_LIMITS} />
      </div>
      <div>
        <p className="panel-note">Prepare: byte budget reached</p>
        <ByteCapNotice limits={HOSTED_LIMITS} />
      </div>
      <div>
        <p className="panel-note">Prepare: failure rollup</p>
        <FailureSummary errors={17} total={500} />
      </div>
      <div>
        <p className="panel-note">Wallet: no extension</p>
        <p className="err-text">{NO_WALLET_MESSAGE}</p>
      </div>
    </div>
  )
}

const meta = {
  title: 'Flow/06 Boundaries',
  component: BoundariesGallery,
} satisfies Meta<typeof BoundariesGallery>

export default meta
type Story = StoryObj<typeof meta>

export const AllSteers: Story = {}
