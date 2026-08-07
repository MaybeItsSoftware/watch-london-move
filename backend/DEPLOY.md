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
| Fly.io | $0.02/GB | Reasonable managed option; `fly.toml` in this directory. |
| Railway | $0.05/GB | |
| Render | $0.10/GB after 100 GB | |
| AWS / GCP | $0.09/GB | 40–70x Hetzner on a pure-egress workload. Avoid. |

`GET /health` reports `bandwidth.bytesPerClientPerHourUncompressed`, averaged
over the last hour of emit ticks. Multiply by average concurrent clients and
730 hours to get a monthly figure, then divide by about 3 for deflate. Measure
this before committing to a host rather than trusting an estimate.

## What keeps egress down

Three things, all on by default. Each can be turned off to measure its effect.

1. **`WS_COMPRESSION`** — permessage-deflate, which socket.io disables by
   default. About 3x on these payloads.
2. **Payload shape** — vehicle records are 8-element tuples with a per-message
   string table, and coordinates rounded to 5dp (~1.1m). Destination and next
   stop are fetched per selection over `vehicles:details`, not broadcast. About
   6x versus carrying a details object per vehicle.
3. **`TILE_SIZE_DEG` viewport scoping** — clients subscribe to the grid cells
   their viewport covers and are only sent those. Worth the most on mobile,
   where a phone at street zoom sees a small fraction of London, and nothing at
   all when zoomed out to the whole network.

Together the first two measure 18x smaller than the original wire format;
scoping is on top of that and depends on zoom.

## Scaling out

Fan-out is single-threaded. Past a few hundred concurrent sockets, TLS and write
syscalls saturate one core. Run multiple instances behind a load balancer — each
polls TfL independently, so also raise `POLL_INTERVAL_MS` or put a shared cache
in front of the API to avoid multiplying upstream requests by instance count.

## Before going live

- Register a TfL app key (`TFL_APP_KEY`). Keyless is rate-limited to ~50 req/min
  and the route-sequence build paces itself 10x slower to compensate.
- Set `CORS_ORIGIN` to the real frontend origin. It defaults to localhost.
  `fly.toml` sets it to the native app origins; append the web origin there.
- Serve over TLS. iOS App Transport Security blocks plain HTTP and WS, so a
  mobile client cannot reach an unencrypted backend.
- Check TfL's API terms for attribution requirements.

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
