import type { Meta, StoryObj } from '@storybook/react-vite'
import { SessionExpiryNote, SessionGrantExplainer } from '../src/components/session-notes.tsx'
import { NO_WALLET_MESSAGE } from '../src/wallet.ts'

/**
 * The wallet step: reached only after the cost gate, so the panel note
 * carries the accepted estimate. The panel chrome is a static fixture; the
 * error string and session explainers are the real exports the app renders.
 */
function WalletPanel({ children }: { children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-no is-current">04</span>
        <h2>Wallet &amp; funds</h2>
        <span className="panel-note">≈0.12 USDFC / month · nothing is stored without your approval.</span>
      </div>
      {children}
    </section>
  )
}

const meta = {
  title: 'Flow/05 Wallet',
  component: WalletPanel,
} satisfies Meta<typeof WalletPanel>

export default meta
type Story = StoryObj<typeof meta>

/** No extension installed: the connect click's failure copy. */
export const NoExtension: Story = {
  args: {
    children: (
      <div className="wallet-row">
        <button className="btn primary" type="button">
          Connect wallet
        </button>
        <span className="err-text">{NO_WALLET_MESSAGE}</span>
      </div>
    ),
  },
}

/** What the one wallet approval authorizes, stated before the grant. */
export const SessionGrant: Story = {
  args: {
    children: (
      <div className="pay-status">
        <span className="pay-label">signing session</span>
        <span className="pay-value session-controls">
          <button className="btn small" type="button">
            Enable signing
          </button>
        </span>
        <SessionGrantExplainer availableLabel="12.50 USDFC" longWindow={false} />
      </div>
    ),
  },
}

/** A long session window adds the on-device key warning. */
export const SessionGrantLongWindow: Story = {
  args: {
    children: (
      <div className="pay-status">
        <SessionGrantExplainer availableLabel="12.50 USDFC" longWindow={true} />
      </div>
    ),
  },
}

/** The pre-expiry warning once a session is close to lapsing. */
export const SessionExpiring: Story = {
  args: {
    children: (
      <div className="pay-status">
        <SessionExpiryNote />
      </div>
    ),
  },
}
