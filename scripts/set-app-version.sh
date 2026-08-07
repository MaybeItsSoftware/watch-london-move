#!/usr/bin/env bash
# Sync a semantic-release version into every place the apps read it:
#
#   frontend/package.json (+ lockfile)                    version
#   frontend/ios/App/App.xcodeproj/project.pbxproj        MARKETING_VERSION / CURRENT_PROJECT_VERSION
#   frontend/android/app/build.gradle                     appVersionName (versionCode derives from it)
#
# Usage: set-app-version.sh <semver>       (called by semantic-release, see .releaserc.json)
#
# Store uploads need a monotonically increasing integer build number, so we
# derive one deterministically from the semver: M*10000 + m*100 + p (assumes
# minor/patch < 100). Because semantic-release only ever bumps the version
# upward, the build code increases too. At deploy time CI overrides it with
# the workflow run number anyway (see fastlane/Fastfile) — the derived value
# is the offline/local fallback. Same scheme as open-parliament.
set -euo pipefail

VERSION="${1:?usage: set-app-version.sh <semver>}"
cd "$(dirname "$0")/.."

# Strip any pre-release / build metadata (e.g. 1.2.3-beta.1 -> 1.2.3): the
# stores want a plain numeric triplet.
CORE="${VERSION%%[-+]*}"
IFS='.' read -r MAJOR MINOR PATCH <<< "$CORE"
BUILD=$(( MAJOR * 10000 + MINOR * 100 + PATCH ))
# Both platforms reject a build number of 0 (only possible for version 0.0.0).
[ "$BUILD" -ge 1 ] || BUILD=1

# frontend/package.json + package-lock.json
(cd frontend && npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null)

# iOS: both build configurations in the pbxproj
PBXPROJ="frontend/ios/App/App.xcodeproj/project.pbxproj"
perl -pi -e "s/MARKETING_VERSION = [^;]+;/MARKETING_VERSION = ${CORE};/g" "$PBXPROJ"
perl -pi -e "s/CURRENT_PROJECT_VERSION = [^;]+;/CURRENT_PROJECT_VERSION = ${BUILD};/g" "$PBXPROJ"
grep -q "MARKETING_VERSION = ${CORE};" "$PBXPROJ" || { echo "error: failed to set MARKETING_VERSION in $PBXPROJ" >&2; exit 1; }

# Android: build.gradle derives versionCode from this line
GRADLE="frontend/android/app/build.gradle"
perl -pi -e "s/^def appVersionName = \"[^\"]*\"/def appVersionName = \"${CORE}\"/" "$GRADLE"
grep -q "^def appVersionName = \"${CORE}\"" "$GRADLE" || { echo "error: failed to set appVersionName in $GRADLE" >&2; exit 1; }

echo "app version -> ${CORE} (build ${BUILD})"
