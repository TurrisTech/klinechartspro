#!/usr/bin/env bash
# Start/stop the client dev server (client/serve.ts) as a background job, so restarting after a
# hostname/port/upstream change doesn't require hunting down the old bun process by hand.
# Logs go to .dev-client.log (gitignored).
#
# No pid file: the server is identified by its command line plus its working directory, which
# stays correct even when a server outlives the shell that started it (Ctrl-C'd terminal, killed
# agent session, a `bun --hot client/serve.ts` run by hand). A pid file goes stale in exactly
# those cases, and the orphan it loses track of then holds the port and breaks the next start.
set -euo pipefail
# readlink -f, not just dirname "$BASH_SOURCE": a symlink to this script (e.g.
# /workspace/klinechartspro.sh) makes dirname resolve relative to the symlink's own location,
# not the real repo, and the cd below lands somewhere unwritable.
ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
cd "$ROOT"

LOG_FILE=.dev-client.log

# `bun` is often absent from a login shell's PATH (it installs to ~/.bun/bin and relies on a
# shell rc export). Without this the nohup below fails with a bare "No such file or directory"
# inside the log, which surfaces as an unrelated-looking startup timeout.
resolve_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return
  fi
  for candidate in "${HOME:-}/.bun/bin/bun" /usr/local/bin/bun; do
    [[ -x "$candidate" ]] && { echo "$candidate"; return; }
  done
  echo "bun not found on PATH (looked in \$HOME/.bun/bin and /usr/local/bin)." >&2
  echo "Install it, or add it to PATH: export PATH=\"\$HOME/.bun/bin:\$PATH\"" >&2
  exit 1
}

# Dev servers belonging to *this* checkout. The cwd test keeps a sibling worktree's server —
# same command line, different directory — out of the blast radius. Linux-only (/proc).
running_pids() {
  local pid
  for pid in $(pgrep -f 'client/serve\.ts' 2>/dev/null || true); do
    [[ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" == "$ROOT" ]] && echo "$pid"
  done
}

stop() {
  local pids
  pids=$(running_pids)
  [[ -z "$pids" ]] || {
    kill $pids 2>/dev/null || true
    # Wait for actual exit, not just signal delivery — start() rebinds the same port right
    # after, and bun can hold it for a moment post-kill.
    for _ in $(seq 1 25); do
      [[ -n "$(running_pids)" ]] || break
      sleep 0.2
    done
    local stragglers
    stragglers=$(running_pids)
    [[ -z "$stragglers" ]] || kill -9 $stragglers 2>/dev/null || true
    echo "stopped dev-client (pid $(echo "$pids" | tr '\n' ' ' | sed 's/ $//'))"
  }
}

start() {
  # Resolve before stopping: if bun can't be found, bail while the running server is still up
  # rather than leaving the caller with nothing.
  local bun
  bun="$(resolve_bun)"
  stop
  nohup "$bun" --hot client/serve.ts >"$LOG_FILE" 2>&1 &
  local pid=$!
  # client/serve.ts prints its "ready at" line once Bun.serve() has bound the port; poll for it
  # instead of a fixed sleep, since bun's startup time varies with HMR cache state. Bail the
  # moment the process dies so real errors surface immediately rather than after the timeout.
  for _ in $(seq 1 50); do
    if grep -q "ready at" "$LOG_FILE" 2>/dev/null; then
      cat "$LOG_FILE"
      return
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "dev-client exited during startup:" >&2
      cat "$LOG_FILE" >&2
      exit 1
    fi
    sleep 0.2
  done
  echo "dev-client did not report ready within 10s:" >&2
  cat "$LOG_FILE" >&2
  exit 1
}

status() {
  local pids
  pids=$(running_pids | tr '\n' ' ')
  pids=${pids% }
  if [[ -n "$pids" ]]; then
    echo "running (pid $pids)"
    tail -n1 "$LOG_FILE" 2>/dev/null || true
  else
    echo "not running"
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) start ;;
  status) status ;;
  *)
    echo "usage: $0 [start|stop|restart|status]" >&2
    exit 1
    ;;
esac
