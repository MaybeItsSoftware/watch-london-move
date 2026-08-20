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

## Web deployment (Vercel)

`.github/workflows/web.yml` deploys the frontend. A pull request gets a preview
deployment; production rides the same release gate as the store builds, so web
and native never diverge on the wire protocol they share with the backend.

The build is done with `npm run build` rather than `vercel build`, because the
Sentry release name is not knowable until the tag exists and the source maps have
to be uploaded and then deleted before anything is published. The output is
assembled into Vercel's Build Output API format from
`frontend/vercel-output-config.json`, which is where the caching and SPA routing
rules live.

Setup, once:

```sh
cd frontend
npx vercel link            # "Set up new project" — decline the Git connection
cat .vercel/project.json   # orgId + projectId → the GitHub secrets below
```

- **Create the project without Git integration**, as above. This is not optional
  housekeeping: a Vercel Hobby account cannot connect a repository owned by a
  GitHub *organisation*, and this repo lives under `MaybeItsSoftware`. Because CI
  uploads a finished build rather than letting Vercel clone and build, Vercel
  never sees the repository and the restriction never applies — but importing
  from Git in the dashboard would walk straight into it and look like a billing
  problem rather than a setup one.
- Git integration would not work here anyway: the build needs
  `VITE_SENTRY_RELEASE` from the git tag, and the source maps must be uploaded to
  Sentry and then deleted before anything is published. Vercel's builder can do
  neither.
- Add **watchlondonmove.maybeitssoftware.co.uk** to the project. `--prod` deploys
  to whatever production domains the project carries, so the workflow never needs
  to know the hostname. DNS for `maybeitssoftware.co.uk` is at Spaceship, not
  Vercel, so the CNAME has to be added there by hand.
- No Root Directory or build command — CI ships prebuilt output.
- Preview comments on pull requests are a Git-integration feature and will not
  appear. `web.yml` deploys previews itself and writes the URL to the job summary.

## Secrets

Beyond the signing material above:

| Secret | Used by | Notes |
|---|---|---|
| `VERCEL_TOKEN` | web.yml | Account or team token. |
| `VERCEL_ORG_ID` | web.yml | From `.vercel/project.json` after `vercel link`, or the dashboard. |
| `VERCEL_PROJECT_ID` | web.yml | Same. |
| `SENTRY_DSN` | web.yml, deploy.yml | Inlined into the bundle. Unset ⇒ no SDK in the build at all. |
| `SENTRY_AUTH_TOKEN` | web.yml | Source-map upload only. Unset ⇒ upload skipped, pipeline still succeeds. |
| `SENTRY_ORG`, `SENTRY_PROJECT` | web.yml | Ditto. |

Source maps are uploaded **once**, by web.yml, under the release tag. The web and
both native bundles are byte-identical for a given tag — the platform is derived
at runtime from `IS_NATIVE` rather than inlined — so one upload symbolicates all
three. If that ever stops being true, native crashes will silently arrive
unsymbolicated; see the comment in `frontend/src/error-reporting.ts`.

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
- [x] **PrivacyInfo.xcprivacy**: added at `frontend/ios/App/App/PrivacyInfo.xcprivacy`
      and wired into the Xcode project's Resources build phase. Declares no
      collected data and the required-reason APIs the Capacitor runtime uses.
      **Re-check it whenever a Capacitor plugin is added or upgraded** — a new
      plugin reaching a new API category is the usual cause of a surprise
      rejection at upload.
- [ ] Reconsider the OpenFreeMap basemap dependency before a public release
      (see `frontend/MOBILE.md`). The app now degrades honestly when it fails —
      a "Basemap unavailable" notice, with vehicles still live — but it is still
      a free keyless server with no SLA in front of every session.

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
