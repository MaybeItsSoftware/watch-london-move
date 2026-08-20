# Deploying the backend

This service is a stateful poller: it holds the live fleet in memory, refreshes
it from the TfL API on a self-scheduling timer, and fans it out over WebSockets.

**Serverless will not work.** Vercel/Lambda-style functions cannot hold long-lived
sockets or run a background polling loop, and the in-memory store would be lost
between invocations. It needs a process that stays up.

## Sizing

| Resource | Need | Why |
|---|---|---|
| RAM | 4 GB | The whole-network bus feed is ~8 MB gzipped and inflates to ~70 MB of JSON on every parse. The spike, not the steady state, sets this. |
| CPU | 2 vCPU | ~1–3s of parse and canonicalisation every poll (15s by default, `POLL_INTERVAL_MS`), plus TLS for the fan-out. |
| Disk | 1 GB volume on `.cache` | Route geometry and the stop-point index. Without it every restart spends ~7 minutes rebuilding routes from the API. |
| Ingress | ~23 GB/day | Free on every host worth using. |
| Egress | scales with clients | See below — this is the entire bill. |

## Egress is the cost

Almost nothing else here costs money, so pick a host on bandwidth price. At the
time of writing, per GB:

| Host | Egress | Notes |
|---|---|---|
| Hetzner / OVH VPS | ~€1/TB after 20 TB included | Cheapest by a wide margin. |
| Fly.io | $0.02/GB | `fly.toml` is still in this directory but is no longer the deployment target. |
| **Railway** | **$0.05/GB** | **The current deployment.** See "Deploying to Railway" below. |
| Render | $0.10/GB after 100 GB | |
| AWS / GCP | $0.09/GB | 40–70x Hetzner on a pure-egress workload. Avoid. |

`GET /health` reports `bandwidth.bytesPerClientPerHourUncompressed`, averaged
over the last hour of emit ticks. Multiply by average concurrent clients and
730 hours to get a monthly figure, then divide by about 3 for deflate. Measure
this before committing to a host rather than trusting an estimate.

That figure only covers the socket feed. The other half of the bill is the cold
start: a client that has never loaded the app pulls the route geometry once,
which is larger than an hour of live updates.

## Deploying to Railway

Railway builds from this directory's `Dockerfile` on every push to `master`.
`railway.toml` holds what can be expressed as code — health check, restart
policy, replica count, sleep. Three things cannot be, and are dashboard-only:

1. **Root Directory = `backend`.** There is no Dockerfile at the repo root, and
   the root `package.json` is frontend orchestration with a husky prepare step.
   Left unset, Railway detects that and builds the wrong thing.
2. **A volume mounted at `/app/.cache`.** Railway *rejects* a Dockerfile
   `VOLUME` instruction — the build fails with "docker VOLUME ... is not
   supported, use Railway Volumes" — so the Dockerfile has none and the mount is
   declared in the dashboard. Without one, *every push* redeploys into a cold container
   and spends ~7 minutes rebuilding route geometry and refetching a 33-page stop
   index from the TfL API — slower still without a `TFL_APP_KEY`. This is the
   single most expensive thing to get wrong, and it is silent: the service comes
   up, serves `503 {"status":"loading"}` from `/routes` for several minutes,
   and nothing says why.
3. **Service variables** — see the checklist below.

Two things Fly gave us for free that Railway does not, both now handled in the
process itself (`config.js`, `rate-limit.js`):

- `fly.toml`'s `hard_limit = 400` was the only ceiling on concurrent sockets.
  `MAX_CONNECTIONS` and `MAX_CONNECTIONS_PER_IP` replace it.
- Fly's private networking meant `/health` was less exposed. On Railway the
  public domain answers everything, so the metrics moved behind `METRICS_TOKEN`.

**`*.railway.internal` is the private network hostname** and resolves only
inside the Railway project. The frontend needs the public domain — Settings →
Networking → Public Networking — because it runs in a browser or a phone, not in
the project.

## What keeps the bill down

Egress is the headline cost *at scale*, but on a hobby deployment the dominant
cost is compute, because this process cannot scale to zero the way a request-
driven service can. Four things address that, in descending order of effect:

1. **Idle poll backoff** (`IDLE_POLL_INTERVAL_MS`). A cycle is a ~10s
   whole-network fetch, an ~80MB parse and a reduce over ~120,000 rows, and it
   used to run every 15s regardless of whether anyone was watching — measured on
   a live deployment at 133 polls against zero connected clients. It now backs
   off when the last client leaves and refreshes the moment one arrives. Set to 0
   to suspend polling entirely while idle.
2. **Sleeping** (`sleepApplication` in `railway.toml`). Only viable *because* of
   the backoff: with nothing on a timer, an unused container can be stopped
   outright. Costs the first visitor after a quiet spell roughly twenty seconds
   of empty map.
3. **Streamed feed parsing.** The whole-network body is reduced row by row
   instead of being buffered, inflated and parsed whole — 259MB to 204MB of peak
   RSS on a realistic feed. Peak is what sizes the container and what
   usage-based hosting charges for.
4. **A volume on `/app/.cache`.** Not a running cost but a per-deploy one:
   without it every deploy rebuilds route geometry from the TfL API, which is
   ~7 minutes and several thousand requests, every time.

## What keeps egress down

Four things, all on by default. Each can be turned off to measure its effect.

1. **`WS_COMPRESSION`** — permessage-deflate, which socket.io disables by
   default. About 3x on these payloads.
2. **Payload shape** — vehicle records are 9-element tuples with a per-message
   string table, and coordinates rounded to 5dp (~1.1m). Destination and next
   stop are fetched per selection over `vehicles:details`, not broadcast. About
   6x versus carrying a details object per vehicle. The ninth field is the
   upcoming-stops schedule, three numbers per stop; `SCHEDULE_STOPS=1` drops it
   to an empty array if the bytes ever need to go.
3. **`TILE_SIZE_DEG` viewport scoping** — clients subscribe to the grid cells
   their viewport covers and are only sent those. Worth the most on mobile,
   where a phone at street zoom sees a small fraction of London, and nothing at
   all when zoomed out to the whole network.
4. **`HTTP_COMPRESSION`** — see below. Nothing else compresses the REST routes:
   permessage-deflate is a WebSocket frame extension and does not apply to them,
   and Fly's proxy passes application responses through untouched.

Together the first two measure 18x smaller than the original wire format;
scoping is on top of that and depends on zoom.

## The cold start: `GET /routes`

The whole network's geometry is the single largest response this service
produces — 662 lines, 121k vertices, 2.69 MB of JSON. Uncompressed it costs the
same egress as roughly 86,000 vehicle records on the live feed, per client, per
fetch. Measured on the real payload:

| Encoding | Bytes | Encode time |
|---|---|---|
| identity | 2,694,082 | — |
| gzip 9 | 643,585 | 263 ms |
| brotli 11 | 255,886 | 2.5 s |

Brotli is chosen over gzip by server preference, not by the order the client
lists them: browsers send `gzip, deflate, br` all at q=1, and honouring that
order would give up 388 KB a client.

Both bodies are built **once per published geometry**, not per request, and held
alongside the memoised FeatureCollection. That is what makes brotli 11 affordable
— it costs 2.5s on a build that already runs for minutes, then serves free
forever. While a build is still in progress the partial body is re-encoded at
every checkpoint, so it drops to gzip 6 / brotli 5 (381 KB, 27 ms). The encode
runs on the libuv threadpool, so it never stalls the emit tick.

On top of that:

- **`ETag` + `If-None-Match`** — a strong validator derived from the build
  timestamp, line count and completeness. A client that already has the geometry
  revalidates into a 304 with no body. The validator is reproduced from the
  on-disk cache after a restart, so a redeploy does not force every client to
  re-download.
- **`Cache-Control`** — `no-store` while the set is still filling in (the body is
  growing), then `public, max-age=3600, stale-while-revalidate=86400`. The
  underlying data has a 7-day TTL and changes a few times a year; the hourly
  expiry bounds staleness rather than tracking real change, and the 304 makes
  paying it cheap.
- **`GET /routes/version`** — `{builtAt, complete, lines, etag}` for a few dozen
  bytes, so a client can decide whether to fetch at all.
- **`GET /routes?v=<builtAt>`** — the same body under
  `public, max-age=604800, immutable`, for a client that already knows which
  build it wants and never needs to revalidate. Only honoured when `v` names the
  build actually being served.

`/stops`, `/snapshot` and `/health` go through the generic `compression`
middleware instead, which negotiates br/gzip/deflate per request. They are small
enough that per-request CPU is not worth avoiding: a 355-stop bbox slice is
29 KB raw and 5.0 KB gzipped, and `/snapshot` is 498 KB raw and 165 KB gzipped.
Set `HTTP_COMPRESSION=false` to measure the difference, or
`HTTP_COMPRESSION_THRESHOLD` (default 1024 bytes) to change where it kicks in.

## Scaling out

Fan-out is single-threaded. Past a few hundred concurrent sockets, TLS and write
syscalls saturate one core — which is what `MAX_CONNECTIONS` refuses past.

**Do not simply raise the replica count.** Railway makes that a toggle, and it is
the wrong move: this process is both the poller and the gateway, so every replica
runs its own TfL polling loop and holds its own in-memory fleet. Clients would
see different vehicles depending on which replica they landed on, and the TfL
request rate would multiply by the replica count.

The shape that scales is one poller publishing canonical state, N stateless
socket gateways, and the socket.io Redis adapter between them. That is the B1
entry in `../PERFORMANCE.md`, and it is worth doing *before* the app is in two
stores rather than after.

## Before going live

The server logs a warning at boot for each of the first three when
`NODE_ENV=production`, so check the deploy logs rather than trusting this list.

- **`TFL_APP_KEY`** — keyless is rate-limited to ~50 req/min and the
  route-sequence build paces itself 10x slower to compensate.
- **`CORS_ORIGIN`** — the web frontend origin:

  ```
  CORS_ORIGIN=https://watchlondonmove.maybeitssoftware.co.uk
  ```

  It defaults to the Vite dev server, so leaving it unset means the deployed web
  app is refused by CORS while the native apps carry on working — a confusing way
  to find out. Setting it to a *localhost* value warns too: the boot check tests
  whether any non-loopback browser origin is allowed, not merely whether the
  variable is present, because copying the value out of `.env.example` is exactly
  how a deployment ends up looking configured and being wrong.
- **`METRICS_TOKEN`** — without it `/health` reports liveness only in
  production. Read the full body with `Authorization: Bearer <token>`.
- **A volume on `/app/.cache`** — see above.
- **TLS.** iOS App Transport Security blocks plain HTTP and WS, so a mobile
  client cannot reach an unencrypted backend. Railway's public domain is HTTPS.
- **Attribution.** TfL's open data terms require it; the frontend carries
  "Powered by TfL" in the map's attribution control alongside the OpenStreetMap
  credit. If the UI changes, that has to survive.

### Rate limits

Every expensive path has a token-bucket budget, because egress is the entire
bill and all of these are cheap to ask for. Defaults and rationale are in
`.env.example`; the enforcement is `rate-limit.js`, shared between the HTTP
routes and the socket handlers so a client cannot dodge one budget by using the
other. `/health` reports `limits.throttledMessages` and
`limits.refusedConnections` to an authorised caller.

The one worth understanding is `vehicles:request-full`: a socket message of a
few bytes that costs a per-tile encode of everything the client is watching. It
gets the tightest budget of anything here (4 burst, then one per 10s).

## Native clients

The iOS and Android apps are the same web bundle running in a Capacitor WebView
(see `../frontend/MOBILE.md`). Two consequences for this service:

- **Their origin is fixed by the platform**, not by a hostname you own:
  `capacitor://localhost` on iOS and `https://localhost` on Android. `config.js`
  therefore allows both unconditionally — `CORS_ORIGIN` is for browsers only.
  Change `androidScheme`/`iosScheme` in `frontend/capacitor.config.ts` and
  `NATIVE_ORIGINS` has to change with it. On a rejection the server logs
  `rejected origin` with what it saw, which is the fastest way to diagnose a
  client that connects to nothing.
- **`https://` and `wss://` are mandatory.** Both platforms block cleartext by
  default (iOS ATS, Android `cleartextTrafficPermitted=false`), so the app cannot
  reach an `http://` backend even on a LAN. The frontend's `VITE_BACKEND_URL` and
  `VITE_SOCKET_URL` are inlined at build time, so a shipped binary is pinned to
  whatever host was set when it was built.

Viewport scoping matters most here: a phone at street zoom subscribes to a
handful of tiles rather than the whole network.
