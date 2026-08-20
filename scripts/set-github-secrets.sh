#!/usr/bin/env bash
#
# set-github-secrets.sh — push the CI/CD secrets from your local .env into the
# repo's GitHub Actions secrets, so .github/workflows/deploy.yml (stores) and
# web.yml (Vercel + Sentry) can run.
#
# Usage:   ./scripts/set-github-secrets.sh
#
# Reads values from the gitignored ./.env (never committed). Values are piped
# via stdin to `gh secret set`, so they never appear in process arguments or
# shell history. This script itself contains NO secret values — safe to commit.
#
# Requires: gh (authenticated, `repo` scope) and a populated ./.env.

set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "error: ./.env not found — copy .env.example and fill it in." >&2; exit 1; }
command -v gh >/dev/null || { echo "error: gh CLI not installed." >&2; exit 1; }

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo "Target repository: $REPO"
gh repo view --json visibility -q '"Visibility: " + .visibility'
echo

# The set of secrets deploy.yml consumes that live in .env. Only these keys are
# pushed; any other lines in .env are ignored. The credential *values* are the
# org-shared ones — copy them from open-parliament's .env (see RELEASING.md).
#
# One deploy secret is NOT in .env and is set separately:
#   - MATCH_GIT_SSH_KEY (read-only deploy key for match-certs; keep it out of .env)
SECRETS="
MATCH_PASSWORD
APP_STORE_CONNECT_API_KEY_ID
APP_STORE_CONNECT_API_KEY_ISSUER_ID
APP_STORE_CONNECT_API_KEY_CONTENT
ANDROID_KEYSTORE_BASE64
KEYSTORE_PASSWORD
KEY_ALIAS
KEY_PASSWORD
PLAY_STORE_SERVICE_ACCOUNT_JSON
VERCEL_TOKEN
VERCEL_ORG_ID
VERCEL_PROJECT_ID
SENTRY_DSN
SENTRY_AUTH_TOKEN
SENTRY_ORG
SENTRY_PROJECT
"

# Pull a single value for KEY from .env, splitting only on the first '='
# (base64 padding and JSON contain '=' / quotes, so never re-split).
env_value() {
  local want="$1" line key
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue;; esac
    key="${line%%=*}"
    [ "$key" = "$want" ] || continue
    printf '%s' "${line#*=}"
    return 0
  done < .env
  return 1
}

set_count=0 miss_count=0
for name in $SECRETS; do
  if value="$(env_value "$name")" && [ -n "$value" ]; then
    printf '%s' "$value" | gh secret set "$name" --repo "$REPO"
    echo "  ✓ set $name"
    set_count=$((set_count + 1))
  else
    echo "  ✗ skipped $name (missing/empty in .env)"
    miss_count=$((miss_count + 1))
  fi
done

echo
echo "Done: $set_count set, $miss_count skipped."
echo "Current secrets on $REPO:"
gh secret list --repo "$REPO"
