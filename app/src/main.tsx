// Fonts are self-hosted (bundled) rather than loaded from a third-party CDN:
// the page stores session signing material, so its CSP allows no remote
// script/style/font origins.
import '@fontsource/hanken-grotesk/400.css'
import '@fontsource/hanken-grotesk/500.css'
import '@fontsource/hanken-grotesk/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/jetbrains-mono/800.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app.tsx'
import './styles.css'

const root = document.getElementById('root')
if (root == null) throw new Error('#root not found')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
