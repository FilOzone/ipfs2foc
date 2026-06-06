import react from '@vitejs/plugin-react'
import { defineConfig, type PluginOption } from 'vite'

// Content-Security-Policy, injected at BUILD time only — the dev server needs
// inline scripts for HMR, and a meta CSP in the source html would break it.
//
// The page stores session signing material (see app/src/session-store.ts), so
// remote script/style/font origins are not allowed: scripts and workers come
// only from the bundle, WASM needs 'wasm-unsafe-eval' (CSP gates WebAssembly
// compilation regardless of the module's origin), inline style attributes are
// used by React components. connect-src must stay https: — the operator
// configures arbitrary gateway hosts and provider service URLs come from the
// on-chain registry, so the network surface cannot be enumerated ahead of
// time; the CSP's value here is blocking remote script injection, plugins,
// and base hijacking, not constraining fetches.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // data: — Vite inlines small font subsets (assetsInlineLimit) as data: URIs.
  "font-src 'self' data:",
  "img-src 'self' data:",
  'connect-src https: wss:',
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  // frame-ancestors cannot be delivered via <meta> (browsers ignore it) and
  // GitHub Pages cannot set response headers — clickjacking framing is an
  // accepted residual on this host.
].join('; ')

function injectCsp(): PluginOption {
  return {
    name: 'inject-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
    },
  }
}

// Project Pages serves under /<repo>/ — keep this in sync with the repo name.
export default defineConfig({
  base: '/ipfs2foc/',
  plugins: [react(), injectCsp()],
  build: { target: 'es2022', outDir: 'dist', sourcemap: false },
  // The commP worker imports the WASM fr32 hasher, which uses top-level await —
  // the default iife worker format cannot represent that.
  worker: { format: 'es' },
})
