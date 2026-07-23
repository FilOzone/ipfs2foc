import type { Meta, StoryObj } from '@storybook/react-vite'
import { Lede } from '../src/components/lede.tsx'
import { HOSTED_LIMITS } from './fixtures.ts'

/**
 * The first five seconds: what the tool does, the CID-continuity promise,
 * and the fit check (caps, wallet, funds) before any wallet interaction.
 */
const meta = {
  title: 'Flow/01 Landing',
  component: Lede,
} satisfies Meta<typeof Lede>

export default meta
type Story = StoryObj<typeof meta>

/** The hosted console: caps stated up front, CLI named for bigger sets. */
export const Hosted: Story = {
  args: { limits: HOSTED_LIMITS },
}

/** A local `serve` daemon is uncapped, so the cap sentence drops out. */
export const LocalServe: Story = {
  args: { limits: null },
}
