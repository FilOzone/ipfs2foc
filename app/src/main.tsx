// Fonts are self-hosted (bundled) rather than loaded from a third-party CDN:
// the page stores session signing material, so its CSP allows no remote
// script/style/font origins.
import '@fontsource/funnel-display/500.css'
import '@fontsource/funnel-display/600.css'
import '@fontsource/funnel-sans/400.css'
import '@fontsource/funnel-sans/500.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { analyticsEnabled, initAnalytics } from './analytics.ts'
import App from './app.tsx'
import { initErrorTracking } from './error-tracking.ts'
import { initAbandonBeacon } from './telemetry.ts'
import { loadCapabilities } from './capabilities.ts'
import LocalDashboard from './local-dashboard.tsx'
import './styles.css'

// One console, two backends: a local `ipfs2foc serve` daemon answers
// /api/capabilities and gets the control-plane view; anywhere else (the
// hosted static site) the fetch fails fast and the in-browser prepare +
// signing flow renders with hosted defaults.
const caps = await loadCapabilities()
initAnalytics(caps)
if (analyticsEnabled()) {
  initAbandonBeacon()
  // import.meta.env.VITE_APP_VERSION is stamped by the Pages build; dev and
  // self-host builds are gated off above anyway.
  void initErrorTracking(import.meta.env.VITE_APP_VERSION ?? 'unversioned')
}

// The two backends get different surfaces from one stylesheet: the scope class
// on <body> selects which set of design tokens resolves. See styles.css.
const local = caps.backend === 'local'
document.body.classList.add(local ? 'local-app' : 'hosted-app')

const root = document.getElementById('root')
if (root == null) throw new Error('#root not found')
createRoot(root).render(<StrictMode>{local ? <LocalDashboard caps={caps} /> : <App caps={caps} />}</StrictMode>)
