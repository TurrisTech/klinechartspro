#!/usr/bin/env bash
# Start/stop the client dev server (client/serve.ts) as a background job, so restarting
# after a hostname/port/upstream change doesn't require hunting down the old bun process by
# hand. Logs go to .dev-client.log; the pid to .dev-client.pid (both gitignored).
set -euo pipefail
# readlink -f, not just dirname "$BASH_SOURCE": a symlink to this script (e.g.
# /workspace/klinechartspro.sh) makes dirname resolve relative to the symlink's own
# location, not the real repo, and the cd below lands somewhere unwritable.
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.."

PORT="${CLIENT_PORT:-${PORT0:-${PORT:-3000}}}"
PID_FILE=.dev-client.pid
LOG_FILE=.dev-client.log

stop() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      # Wait for the process to actually exit, not just for the signal to be sent — start()
      # binds the same port right after, and bun can still hold it for a moment post-kill.
      for _ in $(seq 1 25); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
      done
      echo "stopped dev-client (pid $pid)"
    fi
    rm -f "$PID_FILE"
  fi
}

start() {
  stop
  nohup bun --hot client/serve.ts >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  # client/serve.ts prints its "ready at" line once Bun.serve() has bound the port; poll for
  # it instead of a fixed sleep, since bun's startup time varies with HMR cache state.
  for _ in $(seq 1 50); do
    if grep -q "ready at" "$LOG_FILE" 2>/dev/null; then
      cat "$LOG_FILE"
      return
    fi
    sleep 0.2
  done
  echo "dev-client did not report ready within 10s, check $LOG_FILE" >&2
  exit 1
}

status() {
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "running (pid $(cat "$PID_FILE"))"
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
