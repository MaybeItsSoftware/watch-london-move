# Releasing

The release pipeline is a copy of open-parliament's, adapted for a Capacitor
app: **conventional commits → semantic-release → Fastlane → TestFlight / Play
internal → manual promotion to the stores.**

## How a release happens

1. **Commit with [Conventional Commits](https://www.conventionalcommits.org).**
   A husky `commit-msg` hook (commitlint) rejects anything else. `fix:` → patch,
   `feat:` → minor, `feat!:`/`BREAKING CHANGE:` → major; `docs:`/`chore:`/etc.
   release nothing.
2. **Push/merge to `master`.** The **Release** workflow runs the repo checks
   (backend smoke, frontend lint + build), then `semantic-release`:
   - computes the next version from the commits since the last `vX.Y.Z` tag,
   - runs `scripts/set-app-version.sh`, which syncs the version into
     `frontend/package.json`, the iOS project (`MARKETING_VERSION` /
     `CURRENT_PROJECT_VERSION`) and `frontend/android/app/build.gradle`
     (`appVersionName`, from which `versionCode` derives),
   - updates `CHANGELOG.md`, commits (`chore(release): x.y.z [skip ci]`), tags
     `vx.y.z`, and creates a GitHub Release.
3. **Deploy** fires when Release finishes (`workflow_run` — semantic-release's
   tag can't trigger an `on: push` workflow because it's pushed with
   `GITHUB_TOKEN`). If the commit Release left on `master` is tagged `vX.Y.Z`,
   it builds the Vite bundle, `cap sync`s it into both native projects, and:
   - **iOS**: `fastlane ios beta` — match signing → IPA → TestFlight,
   - **Android**: `fastlane android beta` — signed AAB → Play internal track.

   Build numbers are the workflow run number (`BUILD_NUMBER`), so every store
   upload is strictly increasing.
4. **Promote** (manual, Actions tab → "Promote to Production", input `vX.Y.Z`):
   submits the processed TestFlight build for App Store review and promotes the
   Play internal build to production.

## App identity

Store-facing ID: `uk.co.maybeitssoftware.watchlondonmove` (org convention,
matching open-parliament; Apple Team `6NQNU5YSC2`). It appears in
`capacitor.config.ts`, the iOS `PRODUCT_BUNDLE_IDENTIFIER`, Android's
`applicationId`, and the match profile name `match AppStore
uk.co.maybeitssoftware.watchlondonmove`. The Android code namespace/package
stays `com.maybeitssoftware.watchlondonmove` — it isn't user-visible and
churning it buys nothing.

## Secrets

Deploy needs the org-shared credentials as repo Actions secrets. Copy the
values from open-parliament's `.env` into `./.env` (see `.env.example`), then:

```sh
./scripts/set-github-secrets.sh          # pushes the 9 .env-borne secrets
gh secret set MATCH_GIT_SSH_KEY < key    # match-certs read-only deploy key
```

`.env` pitfalls (each has cost a real CI run): no quotes around values; the
`.p8` is base64 of the *full* PEM including armor; parse `.env` splitting on
the first `=` only.

## One-time store onboarding (not yet done)

- [ ] **Apple**: register the App ID `uk.co.maybeitssoftware.watchlondonmove`
      and create the App Store Connect app record (required before any
      TestFlight upload).
- [ ] **match**: add this app's identifier and run
      `bundle exec fastlane match appstore` once locally — reuses the shared
      distribution cert, creates this app's profile in the match-certs repo.
- [ ] **Play**: create the app in Play Console, do one **manual** `.aab` upload
      (the API can't create the package), map the shared upload-key fingerprint
      into Play App Signing, and invite
      `github-actions-deployer@maybeitssoftware.iam.gserviceaccount.com` as
      release manager scoped to this app.
- [ ] **PrivacyInfo.xcprivacy**: iOS App Store submission requires a privacy
      manifest; the app collects nothing, but the file (declaring e.g.
      UserDefaults use by Capacitor) still needs adding to the Xcode project.
- [ ] Reconsider the OpenFreeMap basemap dependency before a public release
      (see `frontend/MOBILE.md`).

## Versioning mechanics

- The version baseline is the annotated tag `v0.1.0`; semantic-release bumps
  from the highest reachable `vX.Y.Z` tag. **If no tag is reachable it would
  silently release 1.0.0** — the Release workflow fails loudly in that case
  instead (this bit open-parliament twice; don't delete release tags).
- `versionCode`/`CURRENT_PROJECT_VERSION` fall back to a deterministic
  derivation `major*10000 + minor*100 + patch` for local builds; CI always
  overrides with the run number.
- Never upload to a store from a laptop with an ad-hoc `BUILD_NUMBER` — a
  number higher than CI's run counter blocks all future CI uploads. The
  Fastfile refuses to run without an explicit `BUILD_NUMBER` for this reason.
