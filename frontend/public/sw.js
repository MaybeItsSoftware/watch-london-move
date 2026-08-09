/**
 * Watch London Move — service worker. Web only.
 *
 * A cold start pulls ~5.2 MB of data that never changes within a build: the
 * whole network's route geometry (2.69 MB raw / 650 KB gzip) and slices of a
 * 33,118-stop index. Egress is the dominant hosting cost, so the point of this
 * worker is that the *second* visit spends nothing on any of it.
 *
 * Deliberately hand-rolled and dependency-free. Workbox would be a build-time
 * toolchain and ~15 KB of runtime for six routing rules; the repo has no PWA
 * tooling and this file is the whole feature.
 *
 * This file is copied verbatim out of `public/`, then the `wlm-sw-manifest`
 * plugin in vite.config.ts rewrites the four `__WLM_*__` placeholders below
 * with the build's real values. The placeholders are written as valid literals
 * so an un-rewritten copy — `vite dev` serves `public/` as-is — still parses.
 * Nothing registers it in dev, so those values are never used.
 */

const BUILD_ID = '__WLM_BUILD_ID__';
/** Content-hashed JS/CSS emitted by this build. Doubles as the prune list. */
const HASHED_ASSETS = ['__WLM_HASHED_ASSETS__'];
/** `VITE_BACKEND_URL`, so the live feed's origin is matched exactly rather than
 *  guessed from a pathname that any origin could also serve. */
const BACKEND_BASE = '__WLM_BACKEND_BASE__';
/** Origin of the basemap tile server, from `VITE_MAP_STYLE`. A self-hosted
 *  server with different path shapes simply matches nothing below and is passed
 *  straight through, which is the safe direction to fail in. */
const BASEMAP_ORIGIN = '__WLM_BASEMAP_ORIGIN__';

// Bumped only when the *shape* of what is cached changes, which orphans every
// cache below at once. Per-build churn is carried by BUILD_ID on the shell
// cache alone — see STATIC below for why that matters.
const SCHEMA = 'v1';

/** index.html, refetched per build. 1.2 KB, so a per-build copy costs nothing. */
const SHELL = `wlm-shell-${SCHEMA}-${BUILD_ID}`;
/**
 * Hashed chunks, plus the unhashed public files (models/*.glb, icons).
 *
 * Stable name across builds on purpose. The maplibre chunk is 1.0 MB of the
 * 2.2 MB bundle and changes on its own schedule; keying this cache by BUILD_ID
 * would re-download it on every deploy of a one-line app change. Instead
 * `activate` prunes entries under `assets/` that this build did not emit, so
 * unchanged chunks survive a deploy and orphans do not accumulate.
 */
const STATIC = `wlm-static-${SCHEMA}`;
/** The build-time bundled routes.json / stops.json. */
const DATA = `wlm-data-${SCHEMA}`;
/** Backend /routes and /stops?bbox=. */
const API = `wlm-api-${SCHEMA}`;
/** Basemap style, TileJSON, sprite and glyphs. Not tiles — see routing. */
const BASEMAP = `wlm-basemap-${SCHEMA}`;

const OWNED = [SHELL, STATIC, DATA, API, BASEMAP];

/**
 * Per-viewport /stops responses. A long panning session across London touches
 * on the order of tens of bbox keys; 80 covers a session's worth of revisiting
 * without letting a pathological pan grow the cache unbounded.
 */
const API_MAX_ENTRIES = 80;
/** Glyph ranges are ~10 per fontstack and a style uses two or three of them,
 *  plus four sprite files and two JSON documents. 120 is headroom, not a bound
 *  anything realistic reaches. */
const BASEMAP_MAX_ENTRIES = 120;

// The app's own directory, derived from where this script actually sits rather
// than assumed to be the origin root. vite.config.ts sets `base: './'` so the
// bundle can be served from a web root *and* from the Capacitor WebView, which
// means the app may equally well live at https://host/watch-london-move/. The
// worker's max scope is its own directory, so that directory is also exactly
// the set of paths it is allowed to claim.
const ROOT = new URL('./', self.location.href);
const SHELL_URL = new URL('index.html', ROOT).href;

const ROUTES_URL = `${BACKEND_BASE}/routes`;
const STOPS_URL = `${BACKEND_BASE}/stops`;

const HASHED = new Set(HASHED_ASSETS);

self.addEventListener('install', (event) => {
  // No skipWaiting. The build code-splits maplibre and the glTF/mesh-layer
  // stack (see manualChunks in vite.config.ts), so a running session can still
  // request model-layers-<hash>.js minutes after load — the first time the
  // camera reaches the 3D zoom band. Activating over the top of that session
  // and pruning the old build's chunks in the same breath turns the next lazy
  // import into a 404 on a map the user is actively using. The new worker waits
  // for the tab to go away, which is when nothing can ask for the old chunks.
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.add(new Request(SHELL_URL, { cache: 'reload' }))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Navigations are network-first, so the SW's own boot latency (~50-100ms
      // cold) would otherwise sit in front of the HTML request. Preload runs
      // the two in parallel.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }

      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('wlm-') && !OWNED.includes(name))
          .map((name) => caches.delete(name)),
      );

      await pruneStaleAssets();

      // Safe here precisely because there is no skipWaiting: by the time
      // activate runs, no client is holding the previous build. On a first ever
      // visit it means this worker starts serving the page that installed it.
      await self.clients.claim();
    })(),
  );
});

/** Drop `assets/*` this build did not emit. Everything else in STATIC is an
 *  unhashed, stale-while-revalidate file that refreshes itself. */
async function pruneStaleAssets() {
  const cache = await caches.open(STATIC);
  const keys = await cache.keys();
  await Promise.all(
    keys.map((request) => {
      const path = appPath(new URL(request.url));
      if (path === null || !path.startsWith('assets/') || HASHED.has(path)) {
        return undefined;
      }
      return cache.delete(request);
    }),
  );
}

self.addEventListener('message', (event) => {
  // Escape hatch of last resort, for a console one-liner when a page is loading
  // but misbehaving: navigator.serviceWorker.controller.postMessage('wlm-reset')
  if (event.data === 'wlm-reset') {
    event.waitUntil(
      (async () => {
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n.startsWith('wlm-')).map((n) => caches.delete(n)));
        await self.registration.unregister();
      })(),
    );
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // A 206 cannot be written to Cache Storage, and nothing here is worth the
  // partial-response dance.
  if (request.method !== 'GET' || request.headers.has('range')) {
    return;
  }

  const handler = route(request);
  if (handler) {
    event.respondWith(handler(event));
  }
});

/**
 * Allowlist, not denylist. Anything unrecognised gets no respondWith at all and
 * goes to the network untouched — which is the only correct default when the
 * same client is also running a socket.io connection and polling /snapshot.
 *
 * Never matched, and therefore never cached, on the backend origin:
 * `/socket.io/*` (the live vehicle feed, both the polling fallback and the
 * upgrade handshake), `/snapshot`, `/health`, and `/routes/version` — the last
 * of which exists to tell the app when the bundled data went stale and is
 * worthless if it can be answered from a cache.
 */
function route(request) {
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    return navigation;
  }

  const origin = `${url.origin}${url.pathname}`;

  if (origin === ROUTES_URL) {
    // Offline-start insurance for the geometry. Network-first rather than
    // cache-first because the backend serves this with a strong ETag: a
    // revalidation that 304s costs a few hundred bytes, and going to the
    // network keeps a redeployed route set from being pinned behind a cache.
    return (event) => networkFirst(event.request, API);
  }

  if (origin === STOPS_URL) {
    // Per-viewport slices of a static index, already `public, max-age=3600`
    // server-side. Stale is fine — a bus stop does not move — so serve the
    // cached slice instantly and refresh behind it.
    return (event) => staleWhileRevalidate(event, API, API_MAX_ENTRIES);
  }

  if (url.origin === BASEMAP_ORIGIN) {
    return routeBasemap(url);
  }

  const path = appPath(url);
  if (path === null) {
    return null;
  }

  if (HASHED.has(path)) {
    // Vite content-hashes these, so the URL *is* the version. Cache-first with
    // no revalidation is not a staleness risk; a changed file is a changed URL.
    return (event) => cacheFirst(event, STATIC);
  }

  if (path === 'data/routes.json' || path === 'data/stops.json') {
    // Same argument, by a different mechanism: these carry `?v=<builtAt>`, so a
    // given URL's bytes never change. This is the 5.2 MB the whole worker is
    // for. One copy of each is kept — see keepOnlyLatest.
    return (event) => cacheFirst(event, DATA, true);
  }

  // Unhashed app files served from public/: models/*.glb (135 KB across five
  // meshes, fetched lazily at the 3D zoom band) and the icons. Same URL across
  // builds, different bytes, so cache-first would pin an old mesh forever.
  return (event) => staleWhileRevalidate(event, STATIC, 0);
}

function routeBasemap(url) {
  const path = url.pathname;

  // Cached: the fixed, session-invariant part of the basemap. The style JSON,
  // its TileJSON, the sprite sheet and the glyph ranges are ~40 requests well
  // under 1 MB, identical on every visit at every zoom, and the style is a hard
  // dependency — MapLibre renders nothing at all if it fails, so an offline
  // start without it is a blank canvas rather than a degraded map.
  const cacheable =
    path.startsWith('/styles/') ||
    path.startsWith('/fonts/') ||
    path.startsWith('/sprites/') ||
    path === '/planet';

  if (!cacheable) {
    // NOT cached: the vector and raster tiles themselves. London across zooms
    // 10-17 is thousands of tiles and a session touches a different subset each
    // time, so any bound small enough to be responsible thrashes at a low hit
    // rate — while adding a Cache Storage write to every tile response during
    // exactly the pan and zoom gestures that are already this app's jank
    // budget. They are version-stamped in the path
    // (/planet/20260802_080001_pt/{z}/{x}/{y}.pbf) and served with a long
    // max-age, so the HTTP cache already covers the repeat-visit case; the SW
    // would mostly duplicate that storage. Offline therefore gets the basemap's
    // background colour with the app's own content — routes, stops, vehicles —
    // drawn over it, which is where the value actually is.
    return null;
  }

  // Sprites and glyphs come back `max-age=315360000`; the style is `max-age=
  // 86400` and does change. One strategy for all four keeps this simple, and
  // revalidating an immutable file costs a conditional request the HTTP cache
  // usually answers anyway.
  return (event) => staleWhileRevalidate(event, BASEMAP, BASEMAP_MAX_ENTRIES);
}

/** A same-origin URL's path relative to the app directory, or null if it is
 *  outside the worker's scope. */
function appPath(url) {
  if (url.origin !== self.location.origin || !url.pathname.startsWith(ROOT.pathname)) {
    return null;
  }
  return url.pathname.slice(ROOT.pathname.length);
}

async function navigation(event) {
  // Network-first, and this is the escape hatch as much as it is a freshness
  // policy: a worker that could serve a stale shell from cache while the
  // network is fine is a web app you cannot ship a fix to. Every online
  // navigation sees the deploy immediately, including the deploy that removes
  // a broken worker.
  try {
    const preloaded = await event.preloadResponse;
    const response = preloaded || (await fetch(event.request));
    if (response && response.ok) {
      const cache = await caches.open(SHELL);
      await cache.put(SHELL_URL, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(SHELL_URL, { cacheName: SHELL });
    if (cached) {
      return cached;
    }
    return new Response('Offline, and no cached copy of the app.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

async function cacheFirst(event, cacheName, singleton = false) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(event.request);
  if (hit) {
    return hit;
  }

  const response = await fetch(event.request);
  if (storable(response)) {
    await cache.put(event.request, response.clone());
    if (singleton) {
      event.waitUntil(keepOnlyLatest(cache, event.request));
    }
  }
  return response;
}

/**
 * Keep one entry per path in a `?v=`-busted cache. Without this every build the
 * user ever loads leaves its own 2.69 MB routes.json behind, and nothing would
 * ever evict them — the URLs stay valid, they are just never requested again.
 */
async function keepOnlyLatest(cache, request) {
  const keep = new URL(request.url);
  const keys = await cache.keys();
  await Promise.all(
    keys.map((key) => {
      const url = new URL(key.url);
      return url.pathname === keep.pathname && url.search !== keep.search
        ? cache.delete(key)
        : undefined;
    }),
  );
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (storable(response)) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    throw error;
  }
}

async function staleWhileRevalidate(event, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(event.request);

  const revalidate = fetch(event.request)
    .then(async (response) => {
      if (storable(response)) {
        await cache.put(event.request, response.clone());
        if (maxEntries > 0) {
          await trim(cache, maxEntries);
        }
      }
      return response;
    })
    .catch(() => undefined);

  if (cached) {
    event.waitUntil(revalidate);
    return cached;
  }

  const response = await revalidate;
  if (response) {
    return response;
  }
  return new Response('Offline.', { status: 504, headers: { 'Content-Type': 'text/plain' } });
}

/** Opaque responses have status 0 and an unknowable body length, so caching one
 *  is caching something we cannot tell succeeded. Everything cached here is
 *  either same-origin or CORS-enabled, so this only ever rejects a genuine
 *  failure. */
function storable(response) {
  return Boolean(response) && response.ok && response.type !== 'opaque';
}

/** Cache Storage exposes no access times, so eviction is insertion-order FIFO
 *  rather than LRU. cache.keys() returns entries oldest-first. */
async function trim(cache, maxEntries) {
  const keys = await cache.keys();
  const excess = keys.length - maxEntries;
  for (let i = 0; i < excess; i += 1) {
    await cache.delete(keys[i]);
  }
}
