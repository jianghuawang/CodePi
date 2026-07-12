import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * Builds the WKWebView bridge shim (src/bridge/codepi-shim.ts) into a single
 * self-contained IIFE that the Swift shell injects as a WKUserScript at
 * document start. Left unminified: it is small and shows up in Web Inspector.
 */
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/bridge/codepi-shim.ts'),
      formats: ['iife'],
      name: 'CodePiShim',
      fileName: () => 'codepi-shim.js'
    },
    outDir: resolve(__dirname, 'out/bridge'),
    emptyOutDir: true,
    minify: false
  }
})
