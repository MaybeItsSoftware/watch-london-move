import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Stamps `public/sw.js` with the things a service worker cannot work out for
 * itself: which files this build emitted, and which origins are the backend and
 * the tile server.
 *
 * A plugin rather than a hardcoded list because Vite content-hashes every chunk
 * — the filenames are only knowable after the bundle is generated — and rather
 * than a runtime discovery scheme because the worker needs the list at
 * `activate`, before it has a page to ask.
 *
 * Writes over the copy Vite already made from `public/`, instead of emitting an
 * asset, so `sw.js` stays a real file in `public/` that an editor typechecks
 * and `vite dev` serves. Nothing registers it in dev, so the un-stamped
 * placeholders there are never read.
 */
function swManifest(env: Record<string, string>): Plugin {
  let outDir = 'dist'
  let publicDir = 'public'
  let hashed: string[] = []

  return {
    name: 'wlm-sw-manifest',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
      publicDir = config.publicDir
    },
    generateBundle(_options, bundle) {
      // Relative to the app directory, which is how the worker sees them: with
      // `base: './'` there is no leading slash to compare against.
      hashed = Object.keys(bundle)
        .filter((name) => name.endsWith('.js') || name.endsWith('.css'))
        .sort()
    },
    closeBundle() {
      const source = readFileSync(resolve(publicDir, 'sw.js'), 'utf8')
      // The hashed filenames already encode the content of everything they
      // name, so hashing the list is enough to make the shell cache turn over
      // exactly when — and only when — something in the build changed. An
      // identical rebuild reuses the same caches rather than re-downloading.
      const buildId = createHash('sha256').update(hashed.join('\n')).digest('hex').slice(0, 12)
      const basemapOrigin = new URL(
        env.VITE_MAP_STYLE || 'https://tiles.openfreemap.org',
      ).origin

      const replacements: [string, string][] = [
        ["'__WLM_BUILD_ID__'", JSON.stringify(buildId)],
        ["['__WLM_HASHED_ASSETS__']", JSON.stringify(hashed)],
        [
          "'__WLM_BACKEND_BASE__'",
          JSON.stringify((env.VITE_BACKEND_URL || '').replace(/\/+$/, '')),
        ],
        ["'__WLM_BASEMAP_ORIGIN__'", JSON.stringify(basemapOrigin)],
      ]

      let stamped = source
      for (const [token, value] of replacements) {
        if (!stamped.includes(token)) {
          // Failing silently here ships a worker that caches nothing and prunes
          // every asset on activate, which presents as "the SW does not work"
          // long after the rename that caused it.
          throw new Error(`sw.js is missing the ${token} placeholder`)
        }
        stamped = stamped.replace(token, value)
      }

      writeFileSync(resolve(outDir, 'sw.js'), stamped)
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // '' prefix: the SW needs VITE_MAP_STYLE and VITE_BACKEND_URL as build inputs,
  // not as client-side `import.meta.env` reads.
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react(), swManifest(env)],
    // Relative asset URLs so the same bundle works served from a web root and
    // from the Capacitor WebView, whose origin (capacitor://localhost on iOS) is
    // not a normal http origin.
    base: './',
    build: {
      // 'hidden' emits the maps but writes no sourceMappingURL comment into the
      // bundles, so a browser never asks for them and they are not part of what
      // ships. CI uploads them to Sentry and then deletes them before the deploy
      // — see .github/workflows/web.yml. Without this, a Sentry stack trace from
      // a WebView is a wall of single-letter identifiers.
      sourcemap: 'hidden',
      rolldownOptions: {
        output: {
          // Everything used to ship as one ~2.1MB chunk, so a phone parsed the
          // glTF stack before it could draw a single dot. maplibre is the one
          // dependency worth pinning to its own chunk: it is large, it changes on
          // its own schedule, and every session needs it.
          //
          // Deliberately nothing else. Grouping all of @deck.gl into one chunk
          // pulls @deck.gl/mesh-layers — and with it @loaders.gl/gltf — back into
          // the eager graph, which is exactly what src/model-layers.ts exists to
          // keep out of it.
          manualChunks(id: string) {
            if (!id.includes('node_modules')) {
              return undefined
            }
            if (id.includes('maplibre-gl')) {
              return 'maplibre'
            }
            // Named only so it is identifiable in a bundle report and in the
            // service worker's asset list; it is already split by the dynamic
            // import in error-reporting.ts, which is what keeps it out of the
            // cold start. With no VITE_SENTRY_DSN set at build time the DSN
            // check constant-folds and this chunk is never emitted at all.
            if (id.includes('@sentry')) {
              return 'sentry'
            }
            return undefined
          },
        },
      },
    },
  }
})
