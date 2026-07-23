import type { Meta, StoryObj } from '@storybook/react-vite'
import { Led } from '../src/components/continuity.tsx'
import { SessionExpiryNote, SessionGrantExplainer } from '../src/components/session-notes.tsx'
import { FIL_GAS_FLOOR, type FundingInputs, fundingChecklist } from '../src/funding.ts'
import type { PaymentsStatus } from '../src/payments.ts'
import { FlowShell } from './flow-shell.tsx'

/**
 * The wallet step: the funding checklist, reached only after the cost gate.
 * Rows come from the real `fundingChecklist` derivation over fixture inputs,
 * so the single-blocked-row behavior and the row copy are the shipped ones;
 * only the action buttons are inert. The panel note carries the accepted
 * estimate, and the history chrome carries List, Prepare, and Cost receipts.
 */

const FIL = (n: number) => BigInt(Math.round(n * 1e4)) * 10n ** 14n
const USDFC = (n: number) => BigInt(Math.round(n * 1e4)) * 10n ** 14n

const base: FundingInputs = {
  providerDetected: true,
  connected: true,
  onTargetNetwork: true,
  networkLabel: 'Mainnet',
  payments: null,
  requiredUsdfc: USDFC(3),
  signingEnabled: false,
  filSymbol: 'FIL',
}

const funded: PaymentsStatus = {
  fil: FIL(0.25),
  walletUsdfc: USDFC(5),
  depositedUsdfc: USDFC(12.5),
  availableUsdfc: USDFC(12.5),
  operatorApproved: true,
}

function WalletStep({ inputs, after }: { inputs: FundingInputs; after?: React.ReactNode }) {
  const rows = fundingChecklist(inputs)
  return (
    <FlowShell
      active="wallet"
      entries={[
        { stage: 'intake', label: 'Listed 500 items' },
        { stage: 'prepare', label: 'Prepared 497 of 500' },
        { stage: 'cost', label: 'Cost ≈0.12 USDFC / month' },
      ]}
    >
      <section className="panel">
        <div className="panel-head">
          <span className="panel-no is-current">04</span>
          <h2>Wallet &amp; funds</h2>
          <span className="panel-note">≈0.12 USDFC / month · nothing is stored without your approval.</span>
        </div>
        <div className="pay-status fund-list">
          {rows.map((row) => (
            <div className={`fund-row is-${row.state}`} key={row.id}>
              <Led color={row.state === 'done' ? 'var(--ok)' : 'var(--warn)'} on={row.state !== 'waiting'} />
              <span className="fund-title">{row.title}</span>
              {row.detail != null && <span className="fund-detail dim">{row.detail}</span>}
              {row.state === 'blocked' && (
                <span className="fund-action">
                  {row.id === 'wallet' && <a href="https://metamask.io">Install MetaMask</a>}
                  {row.id === 'connect' &&
                    (inputs.connected ? (
                      <button className="btn small" type="button">
                        Switch to Mainnet
                      </button>
                    ) : (
                      <button className="btn small primary" type="button">
                        Connect wallet
                      </button>
                    ))}
                  {row.id === 'fil' && <a href="https://docs.filecoin.io/basics/assets/get-fil">Get FIL</a>}
                  {row.id === 'usdfc' && <a href="#setup-guide">Get and deposit USDFC</a>}
                  {row.id === 'approve' && <a href="#setup-guide">Approve in the setup guide</a>}
                  {row.id === 'signing' && (
                    <button className="btn small primary" type="button">
                      Enable signing
                    </button>
                  )}
                </span>
              )}
            </div>
          ))}
        </div>
        {after}
      </section>
    </FlowShell>
  )
}

const meta = {
  title: 'Flow/05 Wallet',
  component: WalletStep,
} satisfies Meta<typeof WalletStep>

export default meta
type Story = StoryObj<typeof meta>

/** No extension: the first row blocks, everything after renders dim. */
export const NoExtension: Story = {
  args: { inputs: { ...base, providerDetected: false, connected: false } },
}

/** Connected on the wrong chain: the connect row titles the mismatch. */
export const ConnectedWrongNetwork: Story = {
  args: { inputs: { ...base, onTargetNetwork: false, payments: funded } },
}

/** Below the gas floor: balance vs needed, one action. */
export const NoFil: Story = {
  args: {
    inputs: { ...base, payments: { ...funded, fil: FIL_GAS_FLOOR / 5n } },
  },
}

/** Deposited USDFC short of the estimate; undeposited wallet funds called out. */
export const NoUsdfc: Story = {
  args: {
    inputs: {
      ...base,
      payments: { ...funded, availableUsdfc: USDFC(1), depositedUsdfc: USDFC(1) },
    },
  },
}

/** Everything funded: signing is the one blocked row, preview above the grant. */
export const ReadyToSign: Story = {
  args: {
    inputs: { ...base, payments: funded },
    after: <SessionGrantExplainer availableLabel="12.50 USDFC" longWindow={false} />,
  },
}

/** The pre-expiry warning once a session is close to lapsing. */
export const SessionExpiring: Story = {
  args: {
    inputs: { ...base, payments: funded, signingEnabled: true },
    after: <SessionExpiryNote />,
  },
}
