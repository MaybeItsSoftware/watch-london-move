import { defineConfig } from 'vitest/config'

/**
 * Separate from vite.config.ts so the app build stays free of test config —
 * and because vite.config.ts's sw-manifest plugin throws unless it is running
 * against a real bundle.
 *
 * happy-dom rather than node: config.ts reads `matchMedia` at module scope to
 * decide the initial zoom, and prefs.ts talks to localStorage, so both of the
 * modules under test need a document to exist.
 */
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
