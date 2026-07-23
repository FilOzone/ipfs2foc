import type { StorybookConfig } from '@storybook/react-vite'

/**
 * Storybook is a dev-only surface for tuning the console's flow copy and
 * states against fixtures. It has its own Vite config; the app build (CSP
 * plugin, workers) is untouched and ships nothing from here.
 */
const config: StorybookConfig = {
  stories: ['../stories/**/*.stories.tsx'],
  framework: '@storybook/react-vite',
}

export default config
