# watch-london-move

Live map of London's public transport. A Node.js backend polls the TfL
API for the whole network (buses, tube, Overground, DLR, trams), reduces
it to a compact tuple schema, and streams viewport-scoped updates over
socket.io to a WebGL frontend that renders every vehicle as a low-poly
3D model on a MapLibre map.

Originally a fork of [dracos/underground-live-map](https://github.com/dracos/underground-live-map)
(2010, PHP + Leaflet). That generation is archived under [`legacy/`](legacy/)
and reachable at the `legacy-php-site` tag; nothing in it is used by the
current apps.

## Architecture

- [`backend/`](backend/) — Express 5 + socket.io aggregator. Polls TfL,
  canonicalises vehicles into 8-element tuples with a string table,
  partitions them into geographic tiles, and emits full/delta payloads
  per subscribed tile. Route geometry is built from TfL route sequences
  and checkpointed to disk. See [`backend/DEPLOY.md`](backend/DEPLOY.md)
  for Fly.io deployment and cost model.
- [`frontend/`](frontend/) — React 19 + TypeScript + Vite. MapLibre GL
  basemap with deck.gl scenegraph layers rendering glTF vehicle models,
  client-side interpolation between server ticks, and viewport-driven
  tile subscriptions. Also ships as an iOS/Android app via Capacitor —
  see [`frontend/MOBILE.md`](frontend/MOBILE.md).

## Local development

```sh
./dev.sh
```

This copies `.env.example` → `.env` in each app if missing, installs
dependencies, and starts both dev servers (backend on :4000, frontend on
:5173). A TfL API key (`TFL_APP_KEY` in `backend/.env`) raises the rate
limits but is not required to start.

Per-package scripts: see the root [`package.json`](package.json) for
`build`/`lint`/`smoke` shortcuts that run in the right workspace.

## Licence

MIT — see [LICENSE](LICENSE). The archived `legacy/` tree retains its
original licences (© 2010 Matthew Somerville, MIT; PDMarker LGPL) as
described in [`legacy/README`](legacy/README).
