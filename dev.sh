#!/usr/bin/env bash
# Start backend and frontend dev servers together, tearing both down on exit.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for app in backend frontend; do
  dir="$root/$app"
  [ -f "$dir/.env" ] || cp "$dir/.env.example" "$dir/.env"
  [ -d "$dir/node_modules" ] || (cd "$dir" && npm install)
done

cleanup() {
  echo "Stopping dev servers..."
  kill 0
}
trap cleanup EXIT INT TERM

(cd "$root/backend" && npm run dev) &
(cd "$root/frontend" && npm run dev) &

wait
