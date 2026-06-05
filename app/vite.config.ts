import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Project Pages serves under /<repo>/ — keep this in sync with the repo name.
export default defineConfig({
  base: '/ipfs2foc/',
  plugins: [react()],
  build: { target: 'es2022', outDir: 'dist', sourcemap: false },
  // The commP worker imports the WASM fr32 hasher, which uses top-level await —
  // the default iife worker format cannot represent that.
  worker: { format: 'es' },
})
