import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Plain-web build of the renderer for the Swift shell (docs/SWIFT_SHELL_DESIGN.md).
 * Mirrors the renderer section of electron-vite.config.ts; the output is served
 * from the app bundle through the codepi:// URL scheme handler.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true
  }
})
