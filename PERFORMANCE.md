# Performance audit

An audit of `backend/` and `frontend/` against the goal of this being one
codebase that runs well as a website, an iOS app and an Android app.

Everything below is either a measurement or a change made in response to one.
Where a number appears, the script that produced it is named — they are all in
[Reproducing the measurements](#reproducing-the-measurements) — and they were
taken on an Apple-silicon laptop, so treat them as a *floor*: the shared vCPU
the backend deploys to and the mid-range Android the app has to hold 30fps on
are both several times slower, and it is on those that a cost stops being a
number in a profile and starts being something a user feels.

The headline: this codebase was already carefully optimised on the axes its
authors had looked at — bytes on the wire, cold-start payload, tile
subscriptions, level-of-detail bands. The costs that were left were the ones
that are invisible in a network panel: **allocation and blocking**. A frame that
allocates 13,000 objects and a poll that stops the event loop for a third of a
second do not show up as bytes, and both were sitting directly in front of the
user.

---

## Fixed in this pass

### 1. The frame no longer copies the fleet — 0.68ms → 0.17ms

`useVehicles` rebuilt the whole fleet as new objects on every animation frame:
`{...vehicle}` — a 25-field spread — plus a fresh `position` array, per vehicle,
per tick. At 6,500 vehicles and 60fps that is ~800,000 short-lived objects a
second whose only purpose is to carry three numbers the next frame overwrites.

The pose fields moved onto `RenderVehicle` and are now written in place
(`useVehicles.ts`, `updateRow`). A frame allocates one array; the objects in it
are the same ones as last frame.

```
before  0.676 ms/frame   (bench-rows.mjs, 6,500 vehicles)
after   0.173 ms/frame   — 3.9x, and effectively zero garbage
```

The contract that makes this safe is written down on the type: a row is valid
only for the frame that wrote it. Anything that keeps a pose across frames —
the info panel, the follow loop — goes through `VehiclesApi.getDisplayed`, which
detaches a copy. The array handed to deck.gl is still fresh each frame on
purpose: deck decides whether to re-upload an attribute by comparing the `data`
reference, so reusing one would freeze the fleet on screen.

### 2. The UI stopped re-rendering 60 times a second

`App` re-renders on every animation frame — that is how interpolation reaches
the map — and it was dragging the entire UI tree with it. `Sidebar` alone can be
several hundred line rows, and every callback it received was an inline arrow
rebuilt on each render, so `React.memo` would not have helped even if it had
been there.

Three changes, together:

- `Sidebar`, `InfoPanel` and `StatusBar` are memoised.
- Every callback prop is a stable `useCallback` in `App`.
- The panels are clocked at **1Hz** rather than at the frame rate. Everything
  they display is measured in whole seconds — a countdown, "updated 12s ago" —
  so `now` was `Date.now()` read during a render that happens sixty times a
  second to print the same string.

`selectedVehicle` moved with it: it was `rows.find(...)`, a linear scan of 6,500
rows every frame to locate one vehicle, and it returned a live row the next
frame would rewrite underneath the panel holding it. It is now a Map lookup on
the 1Hz clock.

Net: per-frame React work is `App`'s own body — the fleet bucketing and the
layer rebuild, both of which genuinely have to happen — and every child bails
out of reconciliation.

### 3. Frame pacing adapts to the device

`TARGET_FPS` was fixed at 30 for `pointer: coarse` and 60 otherwise. That says
what *kind* of device this is and nothing about what it can sustain — a 2019
Android and a current flagship are both coarse-pointer.

The rAF loop in `useVehicles` is now closed-loop on the frame intervals the
browser actually delivers. It learns the display's own period from the shortest
interval it sees (so 60Hz and 120Hz are read on the same scale), counts frames
that ran more than 1.75x that, and steps the tick rate down when a window is
mostly slow — recovering only after several clean windows, so it cannot
oscillate against its own relief. Floor 15fps. Interpolation is time-based, so a
lower rate costs smoothness and nothing else, while a saturated main thread also
costs input latency.

### 4. The backend stops blocking on the bus feed — 107ms → 7ms

`/Mode/bus/Arrivals?count=-1` is one request covering all ~640 routes, and it
answers with ~80MB of JSON. Read on the main thread that is a single
`JSON.parse` holding the event loop, followed by a reduce over ~120,000 rows —
and for the whole of it nothing else runs. No delta emit, no `/health`, no
WebSocket ping, no HTTP response. Every connected client sees a stall on the
same cadence as the poll.

```
bare JSON.parse, 82MB body        179 ms          (bench-parse.mjs)
```

The request, the parse and the reduce now all happen on a worker thread
(`backend/src/bus-feed-worker.js`); only the few thousand canonical vehicle
records cross back. Measured against a 25MB stand-in feed with a 10ms heartbeat
standing in for a delta emit:

```
                heartbeats served    worst stall
in process           7 / 14            107 ms      (blocking-test.mjs)
worker thread       23 / 22              7 ms
```

Half the heartbeats were simply never delivered in the in-process run. Scale for
the real feed (~3x the body) and the shared vCPU it deploys to, and the stall
this removes is on the order of half a second, every poll.

The fallback is deliberate and total: `BUS_FEED_WORKER=false`, or any failure to
spawn the thread, runs the identical code in process. The two paths were checked
to produce byte-identical output (`worker-test.mjs`). `/health` reports
`busFeedWorker: running | fallback | off`, because a silent fallback to
in-process parsing is exactly the kind of thing that later presents as
unexplained latency.

The stop-point index (~33,000 entries) is mirrored to the worker only when it is
rebuilt — about once a day — rather than with every poll, which would have put a
multi-megabyte structured clone back on the main thread and undone much of the
point. An epoch handshake makes a stale mirror an explicit error rather than a
silently empty fleet.

### 5. The website is installable

There was a complete, hand-written service worker in `public/sw.js` — offline
shell, precached data, per-build asset pruning — and **no web app manifest**, so
none of it added up to an installable app. Android and desktop Chrome had
nothing to offer an install prompt from; the whole feature amounted to a fast
second visit.

Added: `public/manifest.webmanifest`, the 192/512/maskable icons (generated from
the same roundel by `scripts/generate-icons.mjs`, inset to the Android safe
zone), the iOS `apple-mobile-web-app-*` meta tags that stand in for the manifest
there, and Open Graph tags so the site has a title card when it is shared. All
URLs relative, matching `base: './'`, so the same build still serves a web root,
a subdirectory and the Capacitor WebView.

This is the cheapest platform in the matrix: it makes the existing offline work
reachable as an installed app on Android, Windows, macOS and ChromeOS without
touching a store.

---

## Ranked backlog

Ordered by benefit per unit of risk. The first two are the remaining structural
wins on the client and are worth doing together.

### F1 — Binary attributes for deck.gl *(largest remaining client win)*

Now that the fleet is no longer copied per frame, the dominant per-frame cost is
deck.gl walking 6,500 JS objects, calling `getPosition` on each, and rebuilding
a `Float32Array` from the results. Passing binary attributes directly —

```js
data: { length: n, attributes: { getPosition: { value: positions, size: 3 } } }
```

— with `updateRow` writing poses straight into a persistent `Float32Array`
removes the accessor calls, the per-row property loads and the intermediate
array in one move. It is a real refactor of `layers.ts` and `model-layers.ts`
(the buckets become index ranges into one buffer rather than arrays of objects,
and picking needs an index→vehicle map), which is why it is not in this pass.
Expect it to be worth more than everything in section 1 and 2 combined on a
phone.

### F2 — Take the rAF loop out of React entirely

`setTick` still runs a React render per frame purely to reach an effect that
calls `overlay.setProps`. Driving the overlay straight from the rAF callback and
leaving React for genuine UI state would remove the render, the effect
scheduling and the dependency-array churn from the frame. Pairs naturally with
F1, since binary attributes make the layer rebuild cheap enough that the React
round trip becomes the visible cost.

### D1 — The static data is 5MB of JSON

```
public/data/routes.json   2.45 MB raw   545 KB gzip
public/data/stops.json    2.57 MB raw   526 KB gzip
```

Both are parsed on the main thread. `stops.json` is 33,082 objects built and
then re-bucketed into a spatial index — well over 100ms of blocking on a phone,
during the first zoom to street level.

- **`stops.json` → binary.** Coordinates as two `Float32Array`s plus one
  length-prefixed names buffer, with the grid built at *build* time rather than
  on load. Roughly 700KB and a parse measured in single-digit milliseconds.
- **`routes.json` → vector tiles (PMTiles).** Beyond the size, note that
  `installMapLayers` re-adds the whole 2.45MB collection as a GeoJSON source on
  every `style.load` — which is every dusk/dawn transition and every manual
  Day/Night toggle — so MapLibre re-tiles all of it on its worker each time. A
  tiled source makes that incremental and viewport-scoped.

### B1 — One process is the scaling ceiling

`fly.toml` already documents it: `soft_limit = 300` connections, "shard rather
than stacking more onto a machine". The poller and the fan-out are the same
process, so there is no way to add gateway capacity without also multiplying the
TfL polling. The shape that scales is one poller publishing canonical state, N
stateless gateways holding sockets, and the socket.io Redis adapter between
them. Worth doing before, not after, the app is in two stores.

### F3 — Label selection allocates per frame

`chooseLabels` builds a `Map`, materialises its values and sometimes sorts, on
every frame above zoom 14. Labels do not need per-frame placement — they are
deliberately hash-stable so they *don't* move — so recomputing at ~4Hz into a
reused Map is free and correct.

### B2 — `emitTile` serialises every payload twice

`Buffer.byteLength(JSON.stringify(payload))` runs purely for the bandwidth
metric, and socket.io then serialises the same object again. Modest in absolute
terms (~5ms on a full-snapshot tick, ~1ms on a delta) but it is pure waste on
the emit path and it doubles the garbage. Either estimate the size structurally
or sample it, and say which in the metric's name.

### F4 — Bundle split

```
index chunk       922 KB    276 KB gzip    (React + socket.io + deck.gl core/layers)
maplibre chunk  1,028 KB    273 KB gzip
model-layers      247 KB     66 KB gzip    (lazy — correctly so)
```

`maplibre` is already split for exactly the right reason. deck.gl core+layers
deserves the same treatment: it is roughly half the index chunk, it versions
independently of the app, and splitting it lets React and the app shell parse
while it downloads.

### B3 — No per-socket rate limiting

`vehicles:details` caps the *ids per request* at 50 but not the request rate,
and `viewport:set` is unbounded. Neither is expensive individually; both are
trivially loopable by anything that can open a socket. A token bucket per socket
is a few lines and should exist before this is public.

### P1 — `backdrop-filter` on tablets

Four blurred panels compositing over a live WebGL canvas is one of the most
expensive things a mobile GPU can be asked to do, and `App.css` correctly
disables it — but under a width-based media query, so an iPad keeps the blur. A
`(pointer: coarse)` query would catch the case the comment is actually about.

### P2 — No performance budget in CI

CI runs lint, typecheck, build and a schema smoke test. Nothing fails when a
chunk grows 300KB. A byte budget on the emitted chunks and on `public/data/`
would turn every regression in D1 and F4 into a red build rather than a slow
phone.

---

## What is already right

Worth recording so it does not get "optimised" later by someone who has not read
the comments:

- **Tile-scoped subscriptions and delta encoding.** A zoomed-in client is sent
  its own cells and nothing else, with full snapshots only as a periodic
  resync. The tuple schema plus per-payload string table is a good format and
  the reasoning behind every field is written down.
- **Lazy 3D.** The glTF loader, `@deck.gl/mesh-layers` and the five meshes are
  behind a dynamic import latched by the camera crossing zoom 13.5. A session
  that stays zoomed out never downloads any of it.
- **The route-path index.** Geometry projected once into local metres in
  `Float32Array`s, arc lengths and per-segment bearings precomputed, lookups
  memoised on the *stop pair* rather than on a vehicle position — which is what
  makes the cache hit rather than thrash. There is no trigonometry on the
  per-frame path at all.
- **The accessor `updateTriggers` discipline** in `layers.ts`. Colour and radius
  are re-evaluated only when selection or focus changes, never per frame.
- **`/routes`.** Precompressed brotli and gzip buffers, a strong ETag, an
  immutable `?v=` variant, and server-preference encoding negotiation because
  `req.acceptsEncodings` would otherwise hand a browser 644KB of gzip over
  256KB of brotli.
- **The service worker's refusal to cache basemap tiles.** The reasoning — that
  a bound small enough to be responsible thrashes at a low hit rate while adding
  a cache write to every tile during the exact gestures that are the jank
  budget — is correct, and the same conclusion is easy to get wrong.
- **Self-scheduling polls** rather than `setInterval`, so a slow cycle cannot
  stack on the next one.

---

## Reproducing the measurements

The scripts are small and self-contained; they are given here rather than
committed because they are stand-ins, not tests.

| What | How |
| --- | --- |
| Per-frame fleet rebuild | Build a 6,500-entry `Map` of vehicle-shaped objects; time 600 iterations of the row rebuild plus `bucketFleet`, once with a `{...v}` copy and once writing in place. |
| Large-body parse cost | `JSON.stringify` 120,000 TfL-arrival-shaped rows (~82MB) and time `JSON.parse` on it. |
| Event-loop blocking | Serve a 25MB stand-in feed from a local `http` server, run a 10ms `setInterval` heartbeat, and count how many beats are delivered during `fetchAllBusArrivals` with the worker on and off. Count the beats — do not measure the gap, because the longest stall's timer fires *after* the promise resolves and `clearInterval` will beat it. |
| Worker equivalence | Run `fetchAllBusArrivals` against the same stand-in with `busFeedWorker` true and false and compare the serialised results. |
| Bundle | `npm run build --prefix frontend`. |

For the frontend under real load, the honest tool is Chrome DevTools' performance
panel with 4x CPU throttling, or a physical mid-range Android over `adb`. The
numbers here bound the JS; they say nothing about the GPU, and above zoom 14.5
this app is drawing thousands of PBR scenegraphs.
