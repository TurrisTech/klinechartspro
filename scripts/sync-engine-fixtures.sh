#!/usr/bin/env bash
# Vendor the fill-engine parity fixtures from wdashboard-server into the client, or check
# that the two copies are identical (`--check`, what `bun test` runs through
# client/replay/fixtures.test.ts when the server repo is reachable).
#
#   scripts/sync-engine-fixtures.sh            copy
#   scripts/sync-engine-fixtures.sh --check    exit 1 if any file differs
#
# SERVER_FIXTURES overrides the source directory (default: the sibling wdashboard-server
# main worktree's tests/sim/fixtures). The files are generated there --
# gen_engine_cases.py (engine_cases.json, the fill rules as data) and gen_boundaries.py
# (boundaries.json, candle boundaries from wmarkettypes) -- never edited here.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
src=${SERVER_FIXTURES:-$here/../../wdashboard-server/main/tests/sim/fixtures}
dst=$here/client/replay/fixtures
files=(engine_cases.json boundaries.json)
if [[ ! -d "$src" ]]; then
  echo "sync-engine-fixtures: source directory not found: $src" >&2
  exit 2
fi
status=0
for f in "${files[@]}"; do
  if [[ "${1:-}" == "--check" ]]; then
    if ! cmp -s "$src/$f" "$dst/$f"; then
      echo "sync-engine-fixtures: $f differs between $src and $dst" >&2
      status=1
    fi
  else
    cp "$src/$f" "$dst/$f"
    echo "copied $f"
  fi
done
exit $status
