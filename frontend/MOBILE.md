# iOS and Android

The apps are this Vite build running in a [Capacitor](https://capacitorjs.com)
WebView — one codebase, no native map SDK. MapLibre and deck.gl run in
`WKWebView` and Android's WebView unchanged, so anything that works in the
browser works on device.

```
frontend/
  capacitor.config.ts   app id, name, WebView schemes, splash/status bar
  ios/                  Xcode project (committed; build output is gitignored)
  android/              Gradle project (committed; same)
  assets/               PNG masters that generate both platforms' icon sets
```

## Prerequisites

| | |
|---|---|
| iOS | Xcode 15+. Dependencies are Swift Package Manager — no CocoaPods. |
| Android | Android Studio (or the SDK + `ANDROID_HOME`) and **JDK 21**. Capacitor 8's Gradle plugin rejects JDK 17 with `invalid source release: 21`. |

## The loop

```sh
npm run sync        # build + copy the web assets into both platforms
npm run ios         # sync, then open Xcode
npm run android     # sync, then open Android Studio
```

`npm run sync` after *every* web change — the native projects hold a copy of
`dist/`, not a reference to it.

To skip the IDE:

```sh
cd ios && xcodebuild -project App/App.xcodeproj -scheme App \
  -sdk iphonesimulator -destination 'name=iPhone 17 Pro' build
cd android && ./gradlew assembleDebug
```

## Pointing at a backend

`VITE_BACKEND_URL` / `VITE_SOCKET_URL` are **inlined at build time** (Vite), so
a built app is permanently pinned to whatever host was set when it was built.
Changing it means a rebuild, and for a released app a store resubmission.

- Production values live in `.env.production`, read by `npm run build`.
- **`https://` and `wss://` are required.** On Android the app is served from
  `https://localhost`, so anything cleartext is blocked as mixed content; on
  iOS, App Transport Security blocks it. The iOS simulator is more permissive
  about `http://localhost` than a real device — do not read a working simulator
  as proof.
- The backend allows the Capacitor origins (`capacitor://localhost`,
  `https://localhost`) unconditionally, so no CORS setup is needed per
  environment. If you change `androidScheme`/`iosScheme` in
  `capacitor.config.ts`, change `NATIVE_ORIGINS` in `backend/src/config.js` to
  match. See `../backend/DEPLOY.md`.

For a local backend during development:

```sh
VITE_BACKEND_URL=http://localhost:4010 VITE_SOCKET_URL=http://localhost:4010 npm run sync
```

This works **on the iOS simulator only**. On Android the WebView serves the app
from `https://localhost`, so an `http://` backend is blocked as mixed content
before Android's cleartext policy is even consulted — the error is
`Mixed Content: ... attempted to connect to the insecure WebSocket endpoint`,
and no network-security-config can override it. For Android development against
a local backend, put it behind TLS (a `cloudflared`/`ngrok` tunnel is the
quickest) and use the `https://`/`wss://` URL. On a physical device, likewise
use a tunnel rather than a LAN IP.

## Icons and splash screens

`public/favicon.svg` is the single source. `scripts/generate-icons.mjs`
rasterises it into the PNG masters in `assets/` at the three insets the
platforms need (iOS squircle, Android adaptive safe zone, splash), and
`@capacitor/assets` expands those into the platform icon sets.

```sh
npm run icons     # favicon.svg -> assets/*.png + public/apple-touch-icon.png
npm run assets    # assets/*.png -> ios/ and android/ icon and splash sets
npm run sync
```

`@capacitor/assets` is invoked via `npx` rather than kept as a devDependency:
it pulls a large, partly unmaintained tree (including a critical `node-tar`
advisory) for something that runs about once a year.

The splash screen does not auto-hide — `useNativeShell` in `src/lifecycle.ts`
dismisses it once the basemap and the vehicle models are both ready, so it
never uncovers an empty canvas.

## Things that differ from the browser

These are already handled; they are listed because they are easy to undo.

- **Safe areas.** `index.html` sets `viewport-fit=cover` and `App.css` derives
  `--edge-*` from `env(safe-area-inset-*)`. Every floating panel is positioned
  with those variables, never a bare `12px`. MapLibre's own control containers
  get the same padding.
- **Lifecycle.** `useAppActive` (`src/lifecycle.ts`) watches both
  `visibilitychange` and Capacitor's `appStateChange`; iOS does not reliably
  fire the former when a WebView is suspended. On background, `useVehicles`
  stops the animation frame loop and closes the socket — iOS kills a suspended
  socket silently, so without this a resumed app shows `connected` while
  receiving nothing. Resume reconnects and asks for a full resync.
- **Frame rate.** `TARGET_FPS` is 30 on coarse pointers, 60 otherwise. Every
  tick re-derives the whole fleet's pose and rebuilds the deck.gl layers, so
  this is the app's main power draw. Interpolation is time-based, so the lower
  rate costs smoothness only.
- **Touch.** Hit targets are raised to 44px under `@media (pointer: coarse)`,
  which leaves the desktop layout untouched. deck.gl gets `pickingRadius: 8` so
  a fingertip can hit a moving vehicle. Panel `backdrop-filter` is dropped on
  touch devices — four blurred layers over a live WebGL map is expensive.
- **Initial camera.** Zoom 12 on narrow screens rather than 10, and the sidebar
  starts collapsed; at zoom 10 a pitched phone viewport opens on the Home
  Counties with London near the horizon.
- **No unicode glyph icons.** `☰` and `✕` are not in the iOS system font and
  render as tofu boxes; `Sidebar.tsx` draws them as inline SVG.
- **Relative asset URLs.** `vite.config.ts` sets `base: './'` and model loading
  uses `import.meta.env.BASE_URL`, because the WebView origin is not a web root.

## Not done

- No Fastlane, CI, code signing, or store metadata. The `mobile-release-setup`
  skill covers TestFlight and Play deployment.
- No `PrivacyInfo.xcprivacy`. The app collects nothing, but iOS 17+ requires the
  file for App Store submission.
- The JS bundle is ~2.1 MB (590 kB gzipped) in one chunk, which is a slow cold
  start in a WebView. Code-splitting deck.gl would help.
- Basemap tiles come from OpenFreeMap, a free keyless public server, with no
  offline handling or error state. Fine for development; a dependency worth
  reconsidering before a store release.
