# Privacy Policy

**Last updated:** 20 August 2026

This policy explains what happens to your information when you use **Watch London
Move** — the website at `watchlondonmove.maybeitssoftware.co.uk` and the iOS and
Android apps of the same name (together, the "App"), published by
**MaybeItsSoftware**.

The App shows London's buses, trains and trams moving in real time. It has no
accounts, no sign-in, and nothing to personalise, so there is very little to say
here — but what there is, is said precisely.

---

## 1. What we do not collect

We do not collect, store or transmit personal data about you.

* **No account, no sign-in, no identifier.** The App never asks who you are and
  never assigns you a user id, advertising id, or any other persistent token.
* **No device location.** The App does not use the geolocation API and does not
  request location permission on either platform. It shows you where *vehicles*
  are, never where you are. The Android build requests one permission,
  `INTERNET`; the iOS build requests none.
* **No analytics, tracking or advertising.** There is no analytics SDK, no
  tracking pixel, no advertising network, and nothing is shared with data
  brokers. The iOS privacy manifest (`PrivacyInfo.xcprivacy`) declares tracking
  as `false` and an empty set of collected data types.
* **No cookies.** The App sets no cookies and stores no personal data in the
  browser.

---

## 2. What is stored on your device

Everything the App stores is local, and none of it describes you.

* **Cached map data.** On the web, a service worker caches the application code,
  the map's route geometry and its stop index (roughly 5 MB) so that a second
  visit loads quickly and costs no bandwidth. In the iOS and Android apps the
  same files are bundled into the app itself.
* **One session flag.** If you disable the service worker using `?sw=off`, the
  App records that choice in `sessionStorage` under the key `wlm-sw-off` so it is
  not immediately re-enabled. It is discarded when you close the tab.

You can remove all of it by clearing the site's storage in your browser, or by
uninstalling the app.

---

## 3. What is sent to our server

The App connects to a backend that collects live vehicle positions from
Transport for London and relays them to you.

* **The area of the map you are viewing.** So that we send you only the vehicles
  on your screen rather than all of London's, your app tells the server the
  geographic bounds of the current map view. This is the part of the *map* you
  have scrolled to. It is not your location, it is not derived from your
  location, and it is not stored — it is held in memory for the life of the
  connection and discarded when you disconnect.
* **Your IP address, in the ordinary course of being connected.** Any server you
  connect to necessarily sees your IP address. We use it for one purpose: rate
  limiting, so that one client cannot exhaust a service whose costs are shared.
  It is held in memory in a counter that is discarded once it goes idle.
* **Server logs.** The server writes operational logs which, for abnormal events
  only — a connection refused for exceeding a limit, a request rejected as
  coming from an unexpected origin — include the IP address involved. Ordinary
  connections are logged with a random per-connection id and no address. These
  logs exist to keep the service running and are not used to build any profile.

We do not sell, rent or share this information, and there is nothing in it that
identifies you.

---

## 4. Crash reporting

To find and fix faults, the App can report errors to **Sentry**, a service
provided by Functional Software, Inc. When an error occurs, a report may include:

* the error message and a stack trace,
* the app version and release,
* your browser or WebView user-agent string,
* the time it happened.

It does **not** include your IP address as a user identifier, any account
details, the contents of your screen, or session recordings. Session replay and
performance tracing are switched off. Reports are deduplicated and capped per
session, so a repeating fault does not generate an unbounded stream.

The reporting code is only ever active in builds configured with a Sentry key.
Where no key is configured, the reporting library is not included in the build at
all.

Sentry's own policy: <https://sentry.io/privacy/>

---

## 5. Third parties

Using the App necessarily involves a few other services, each of which will see
your IP address because your device connects to them directly.

| Service | Why | Their policy |
|---|---|---|
| **OpenFreeMap** | Serves the background map tiles. | <https://openfreemap.org/> |
| **Vercel** | Hosts the website. | <https://vercel.com/legal/privacy-policy> |
| **Railway** | Hosts the live-data backend. | <https://railway.com/legal/privacy> |
| **Sentry** | Crash reporting, as above. | <https://sentry.io/privacy/> |

Vehicle data comes from **Transport for London's** open data API. That is a
request *we* make from our server, not one your device makes, so TfL does not see
you. Powered by TfL Open Data.

If you installed from the App Store or Google Play, Apple or Google may collect
information about the download under their own policies, which we do not control.

---

## 6. Children

The App is not directed at children and collects no personal data from anyone,
including children.

---

## 7. Your rights

Because we hold no personal data about you, there is nothing for us to retrieve,
correct or delete on request. If you believe otherwise, contact us and we will
look into it.

Where UK GDPR applies to the limited processing described in Section 3, our
lawful basis is legitimate interest: operating the service and protecting it from
abuse.

---

## 8. Changes

If this policy changes, the "last updated" date above changes with it. The
history of this file is public in the project's Git repository, so any change can
be inspected in full.

---

## 9. Contact

Questions about this policy: **<!-- TODO: contact address -->**

Watch London Move is open source. Its complete source, including everything
described here, is at <https://github.com/MaybeItsSoftware/watch-london-move>.
