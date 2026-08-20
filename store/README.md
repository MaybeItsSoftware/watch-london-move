# Store artwork

The listing artwork for both stores, in the L/swiss language: Archivo 900 set
tight on cold white, one hard rule, bus red as the only accent, and the app's
six mode colours as a streak band.

    npm run store        # or: node scripts/store-assets/build.mjs

Output goes straight into the layout fastlane already expects:

| Path | Consumer |
|---|---|
| `fastlane/screenshots/en-GB/` | `deliver` → App Store screenshots |
| `fastlane/metadata/en-GB/` | `deliver` → App Store text |
| `fastlane/metadata/android/en-GB/` | `supply` → Play text |
| `fastlane/metadata/android/en-GB/images/` | `supply` → Play artwork |
| `store/build/` | the 1024 icon master and a contact sheet |

The text is hand-written and lives in the repo; `npm run store` checks every
field against its character ceiling, since a description that grew past 4000 or
a Play changelog past its unusually tight 500 otherwise surfaces at submission.

**Nothing uploads as a result.** Both lanes in `fastlane/Fastfile` still pass
`skip_metadata` / `skip_screenshots` / `skip_upload_images`; these files sit
inert until someone flips those flags, which is what the note in that file
describes.

## What is generated

Four scenes — `01-fleet`, `02-modes`, `03-daylight`, `04-close` — rendered at
every size the two stores ask for:

- **App Store** — iPhone 6.9" (1320×2868) and iPad 13" (2064×2752) are the
  required pair, since `TARGETED_DEVICE_FAMILY` is `"1,2"`. 6.7", 6.5" and iPad
  12.9" are emitted as accepted alternates.
- **Play** — phone (1080×1920), 7" (1200×1920), 10" (1600×2560), the 1024×500
  feature graphic, and the 512 icon.

Play gets its own renders rather than resized iPhone masters: 1290×2796 is
2.17:1 and trips Play's 2:1 aspect ceiling.

The build validates every deliverable for alpha, file size and aspect before it
finishes, because each of those fails late — at submission, not at render time.
Alpha is the easy one to get wrong: sharp applies `flatten` *before* `composite`
in its fixed pipeline, so flattening in the same chain that composites the map
still hands back a 32-bit PNG.

## The map imagery is a stand-in

By default the map inside each frame is drawn from the app's own route geometry
(`frontend/public/data/routes.json`) with vehicles placed by a seeded PRNG.
**It is not live TfL data and must not be what ships.**

Drop real captures into `store/captures/` named for the scene — `01-fleet.png`,
`02-modes.png`, `03-daylight.png`, `04-close.png` — and every target picks them
up automatically, cover-cropped to the frame. The build prints which source it
used.

## Blockers before the skip flags come off

- **The privacy policy page does not exist.** `privacy_url.txt` points at
  `https://watchlondonmove.maybeitssoftware.co.uk/privacy`, which is where it
  ought to live — but nothing is published there yet, and both stores require a
  reachable policy. Publish the page or change the file.
- **The app icon in the binary.** App Store Connect takes the iOS marketing
  icon from the app's asset catalogue, not from an upload — so until the streak
  mark replaces the roundel in `frontend/public/favicon.svg` and
  `frontend/scripts/generate-icons.mjs`, the icon on the iOS listing will still
  be the old roundel while `store/build/app-icon-1024.png` shows the new one.
- **Crash reporting vs the privacy manifest.** `deploy.yml` builds the store
  binaries with `VITE_SENTRY_DSN` set from a secret, so a shipped build sends
  crash reports to Sentry. `PrivacyInfo.xcprivacy` declares
  `NSPrivacyCollectedDataTypes` as empty and its comment says crash reporting is
  off in shipped builds — which was true when only `VITE_ERROR_ENDPOINT`
  existed. One of the two needs to change before the App Privacy answers in App
  Store Connect can be filled in honestly.
- **Set in the consoles, not here**: app categories, age rating, the Play Data
  Safety form, and App Store review contact details.

## Layout

    scripts/store-assets/
      build.mjs              the only entry point
      lib/                   palette, streak language, map plate, font setup
      fonts/                 Archivo, vendored

    store/
      README.md              this file
      build/                 icon masters + contact sheet
      captures/              drop real screenshots here

Archivo is vendored under `scripts/store-assets/fonts/` because
sharp resolves `font-family` through fontconfig against whatever the machine has
installed. `fc-match` against the bundled config is how to check none is
silently falling back to Helvetica.
