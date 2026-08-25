#!/usr/bin/env bash
# Build the wdashboard client image (wdashboard-klinechartpro) LOCALLY and push to Gitea.
#
# This workstation has no Docker daemon and rootless container builders are blocked by seccomp
# (see the server's bin/docker_build.sh for the full note), so we build the bundle NATIVELY --
# the exact step the Dockerfile's builder stage runs -- then assemble the nginx image with
# `crane` (github.com/google/go-containerregistry) and push. crane runs no container; it only
# reads/writes registry blobs.
#
# Requires GITEA_USERNAME and GITEA_TOKEN (the registry push only — the client build reaches
# no private index). Run through `direnv exec /workspace` so both are loaded from Infisical.
# Needs bun on PATH (~/.bun/bin).
#
# Usage:
#   scripts/build-image.sh                 # tag = client-<shortsha>, push to Gitea
#   scripts/build-image.sh client-abcdef1  # explicit tag, push to Gitea
#   OUTPUT=/tmp/cli.tar scripts/build-image.sh   # write a local image tarball, do NOT push
#   BASE_PATH=/sub/ scripts/build-image.sh       # serve under a sub-path (default /)
set -euo pipefail

REGISTRY="gitea.turris.app"
IMAGE="${REGISTRY}/public-org/wdashboard-klinechartpro"
REPO_DIR="$(cd "$(dirname "$(dirname "$(realpath "$0")")")" && pwd)"
cd "$REPO_DIR"

# The client image is tagged by commit only — package.json's version belongs to the published
# @klinecharts/pro library, not the client under client/.
TAG="${1:-client-$(git rev-parse --short HEAD)}"
REF="${IMAGE}:${TAG}"
BASE_PATH="${BASE_PATH:-/}"
: "${GITEA_USERNAME:?GITEA_USERNAME not set — run via: direnv exec /workspace $0}"
: "${GITEA_TOKEN:?GITEA_TOKEN not set — run via: direnv exec /workspace $0}"

# The runtime base is whatever client/Dockerfile's second FROM uses.
BASE="$(grep -E '^FROM ' client/Dockerfile | tail -1 | awk '{print $2}')"
BASE="${BASE:-nginx:1.27-alpine}"

# --- crane (auto-install to ~/.local/bin) --------------------------------------------------
CRANE="$(command -v crane || echo "$HOME/.local/bin/crane")"
if ! "$CRANE" version >/dev/null 2>&1; then
  echo "==> installing crane to ~/.local/bin"
  mkdir -p "$HOME/.local/bin"
  curl -fsSL "https://github.com/google/go-containerregistry/releases/latest/download/go-containerregistry_Linux_x86_64.tar.gz" \
    | tar -xz -C "$HOME/.local/bin" crane
  chmod +x "$HOME/.local/bin/crane"
fi
"$CRANE" auth login "$REGISTRY" -u "$GITEA_USERNAME" -p "$GITEA_TOKEN" >/dev/null

# --- 1. build the bundle natively, exactly as the Dockerfile builder does -------------------
echo "==> bun install --frozen-lockfile"
bun install --frozen-lockfile
echo "==> building client bundle (BASE_PATH=$BASE_PATH)"
BASE_PATH="$BASE_PATH" bun run scripts/build-client.ts

# --- 2. assemble the image layer (mirrors the Dockerfile runtime stage's COPYs) -------------
echo "==> staging image layer"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/stage"
mkdir -p "$STAGE/usr/share/nginx/html" "$STAGE/etc/nginx/conf.d"
cp -r client-dist/. "$STAGE/usr/share/nginx/html/"
cp client/nginx.conf "$STAGE/etc/nginx/conf.d/default.conf"
LAYER="$WORK/layer.tar"
tar --owner=0 --group=0 -C "$STAGE" -cf "$LAYER" .

# --- 3. append onto nginx + set the label/port, then push (or write a tarball) --------------
if [ -n "${OUTPUT:-}" ]; then
  echo "==> writing local image tarball $OUTPUT (no push)"
  "$CRANE" mutate "$BASE" --append "$LAYER" \
    --label "app.wdashboard.base-path=$BASE_PATH" --exposed-ports 80/tcp \
    -t "$REF" -o "$OUTPUT"
  echo "==> wrote $OUTPUT (tagged $REF)"
else
  echo "==> pushing $REF"
  "$CRANE" mutate "$BASE" --append "$LAYER" \
    --label "app.wdashboard.base-path=$BASE_PATH" --exposed-ports 80/tcp \
    -t "$REF"
  echo "==> pushed $REF"
  "$CRANE" digest "$REF" | sed 's/^/    digest: /'
fi
