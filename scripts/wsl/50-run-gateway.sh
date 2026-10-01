#!/usr/bin/env bash
# Ferrum stage 1: run the gateway in the FOREGROUND (Ctrl+C stops it). The autostart service
# comes in stage 6. Refuses to start unless the sandbox prerequisites are in place.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
refuse_root
export PATH="$HOME/.local/bin:$PATH"
CFG="$OC_HOME/openclaw.json"
[ -f "$CFG" ] || die "no config: run scripts/wsl/40-configure.sh"
node "$REPO/scripts/check-config.mjs" "$CFG" || die "config violates Ferrum invariants; refusing to start"
docker info >/dev/null 2>&1 || die "docker is not reachable without sudo; sandbox cannot start (and OpenClaw will refuse to run tools)"
docker image inspect ferrum-sandbox:bookworm-slim >/dev/null 2>&1 || die "sandbox image missing: run scripts/wsl/30-build-sandbox-image.sh"
[ -d "$HOME/ferrum/workspace" ] || die "workspace missing: run scripts/wsl/40-configure.sh"
echo "Starting gateway on 127.0.0.1:18789 (loopback only). In Telegram, write to your bot."
echo "Panel: http://127.0.0.1:18789/  (token is in $ENV_FILE as OPENCLAW_GATEWAY_TOKEN)"
cd "$REPO"
exec node_modules/.bin/openclaw gateway run
