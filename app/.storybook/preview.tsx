import type { Preview } from '@storybook/react-vite'
import '@fontsource/funnel-display/500.css'
import '@fontsource/funnel-display/600.css'
import '@fontsource/funnel-sans/400.css'
import '@fontsource/funnel-sans/500.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '../src/styles.css'

// The stylesheet keys its tokens off the surface class main.tsx stamps on
// <body>; stories render the hosted (public self-service) surface.
document.body.classList.add('hosted-app')

const preview: Preview = {
  decorators: [
    (Story) => (
      <div className="shell">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
    backgrounds: { disable: true },
  },
}

export default preview
