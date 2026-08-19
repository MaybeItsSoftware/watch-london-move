# watch-london-move

Live map of London's public transport. A Node.js backend polls the TfL
API for the whole network (buses, tube, Overground, DLR, trams), reduces
it to a compact tuple schema, and streams viewport-scoped updates over
socket.io to a WebGL frontend that draws all ~6,500 of them on a MapLibre
map: colour-coded dots at city scale, low-poly 3D models once the camera
is close enough for a vehicle to be worth looking at.

Originally a fork of [dracos/underground-live-map](https://github.com/dracos/underground-live-map)
(2010, PHP + Leaflet). That generation is archived under [`legacy/`](legacy/)
and reachable at the `legacy-php-site` tag; nothing in it is used by the
current apps.

## Architecture

- [`backend/`](backend/) — Express 5 + socket.io aggregator. Polls TfL,
  canonicalises vehicles into 9-element tuples with a string table,
  partitions them into geographic tiles, and emits full/delta payloads
  per subscribed tile. Route geometry is built from TfL route sequences
  and checkpointed to disk. See [`backend/DEPLOY.md`](backend/DEPLOY.md)
  for Fly.io deployment and cost model.

  The whole-network bus feed — one request covering all ~640 routes, and
  ~80 MB of JSON in reply — is fetched, parsed and reduced on a worker
  thread ([`bus-feed-worker.js`](backend/src/bus-feed-worker.js)); only
  the few thousand canonical records cross back. Read on the main thread
  it stalled every connected client for the length of a `JSON.parse`,
  measured at 107 ms for a 25 MB stand-in and considerably worse on the
  shared vCPU this deploys to. `BUS_FEED_WORKER=false` runs the identical
  code in process, which is also the automatic fallback if the thread
  cannot start; `/health` reports which is in use.

  The last tuple field is the vehicle's `schedule`: the stops *after* the
  one it is currently heading for, flattened to `[lat, lon, secs]`
  triples, `secs` being relative to the payload's `generated_at` exactly
  as the single-stop countdown in field 7 is. TfL's feed already carries
  about eight predictions per vehicle and the backend used to keep one,
  which left a client with nothing to animate the moment a vehicle
  reached its stop. `SCHEDULE_STOPS` sets how many stops each vehicle
  carries including the current one (default 3, clamped 1..5); 1 restores
  the old single-stop behaviour and always sends an empty schedule.
- [`frontend/`](frontend/) — React 19 + TypeScript + Vite. MapLibre GL
  basemap that follows London's daylight, deck.gl layers over it,
  client-side interpolation between server ticks, and viewport-driven
  tile subscriptions. Also ships as an iOS/Android app via Capacitor —
  see [`frontend/MOBILE.md`](frontend/MOBILE.md).

  The vehicle layer has three bands. Below zoom 13.5 the whole fleet is
  one `ScatterplotLayer` of screen-sized dots; above 14.5 it is glTF
  models with route-number blinds above them; between the two they
  cross-fade. The models, the glTF loader and `@deck.gl/mesh-layers` are
  all imported lazily on first entry to that band, so a session that
  stays zoomed out never downloads them.

  Vehicle colour comes from `LIVERY_COLORS` in
  [`frontend/src/config.ts`](frontend/src/config.ts), not from the TfL
  brand colours directly: `getColor` is a multiply against a near-white
  mesh, so brand colours are lifted to a luminance floor first, and each
  bus route takes a stable variation on TfL red so 6,500 identical
  vehicles are not one indistinguishable mass.

  Models are generated, not authored — run `npm run models` in
  `frontend/` after editing
  [`scripts/generate-models/`](frontend/scripts/generate-models/).

  On the web it is also an installable PWA: a hand-written service worker
  ([`public/sw.js`](frontend/public/sw.js)) caches the shell, the chunks
  and the bundled data, and
  [`public/manifest.webmanifest`](frontend/public/manifest.webmanifest)
  is what makes that reachable as an installed app on Android, desktop
  Chrome and iOS home screens. Icons come from the same roundel as the
  native ones — `npm run icons`.

## Performance

[`PERFORMANCE.md`](PERFORMANCE.md) is a measured audit of both apps: what
the per-frame and per-poll costs actually are, what was changed in
response, and a ranked backlog of what is left. Read it before optimising
anything here — several things that look wasteful are deliberate, and the
reasons are recorded.

## Bundled static data

Route geometry and the stop index are effectively static — TfL changes
route geometry a few times a year — but they were the whole of a cold
start's ~5.2 MB of backend traffic: `GET /routes` once (662 lines,
121,405 vertices) and `GET /stops?bbox=` on every camera settle above
zoom 15, out of a 33,082-stop index. Egress is the hosting bill's
dominant line, so both now ship inside the build instead:

```sh
cd frontend && npm run static-data   # against a running backend
```

That writes `public/data/routes.json`, `public/data/stops.json` and
`src/static-data-manifest.json`, quantising every coordinate to 5 dp
(~1.1 m, the same precision the backend's wire encoder already uses).
All three are **committed**, so CI and a fresh clone build without a
live backend. Regenerate them when TfL's geometry moves.

At runtime [`frontend/src/static-data.ts`](frontend/src/static-data.ts)
resolves the bundled copy first — off the static host on web, out of the
app binary on native, so the backend serves neither — then asks
`GET /routes/version` in the background and only pulls the full
collection when the backend reports a *newer* build than the manifest
baked into the JS bundle. With no bundled copy (a dev checkout, or a
build where the script was never run) it falls back to fetching
`/routes` with the original backoff and progressive top-up.

## Local development

```sh
./dev.sh
```

This copies `.env.example` → `.env` in each app if missing, installs
dependencies, and starts both dev servers (backend on :4010, frontend on
:5173). A TfL API key (`TFL_APP_KEY` in `backend/.env`) raises the rate
limits but is not required to start.

Per-package scripts: see the root [`package.json`](package.json) for
`build`/`lint`/`smoke` shortcuts that run in the right workspace.

## Licence

MIT — see [LICENSE](LICENSE). The archived `legacy/` tree retains its
original licences (© 2010 Matthew Somerville, MIT; PDMarker LGPL) as
described in [`legacy/README`](legacy/README).
