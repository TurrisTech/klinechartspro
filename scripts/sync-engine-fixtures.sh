#!/usr/bin/env bash
# Vendor the parity fixtures from wdashboard-server into the client, or check that the two
# copies are identical (`--check`, what `bun test` runs through client/replay/fixtures.test.ts
# and client/watch/fixtures.test.ts when the server repo is reachable).
#
#   scripts/sync-engine-fixtures.sh            copy
#   scripts/sync-engine-fixtures.sh --check    exit 1 if any file differs
#
# SERVER_ROOT overrides the server worktree (default: the sibling wdashboard-server main
# worktree); SERVER_FIXTURES still overrides the sim fixture directory on its own. Every file
# is GENERATED there and never edited here:
#
#   tests/sim/fixtures    engine_cases.json  the fill rules as data (gen_engine_cases.py)
#                         boundaries.json    candle boundaries from wmarkettypes
#   tests/watch/fixtures  watch_cases.json   when a watch fires (gen_watch_cases.py) -- the
#                                            rule a bar replay evaluates in the browser
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
root=${SERVER_ROOT:-$here/../../wdashboard-server/main}
sim=${SERVER_FIXTURES:-$root/tests/sim/fixtures}
# "<source dir>|<destination dir>|<file>"
pairs=(
  "$sim|$here/client/replay/fixtures|engine_cases.json"
  "$sim|$here/client/replay/fixtures|boundaries.json"
  "$root/tests/watch/fixtures|$here/client/watch/fixtures|watch_cases.json"
)
status=0
for pair in "${pairs[@]}"; do
  IFS='|' read -r src dst f <<<"$pair"
  if [[ ! -d "$src" ]]; then
    echo "sync-engine-fixtures: source directory not found: $src" >&2
    exit 2
  fi
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
