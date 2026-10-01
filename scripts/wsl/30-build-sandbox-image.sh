#!/usr/bin/env bash
# Ferrum stage 1: build the sandbox image from docker/sandbox/Dockerfile.
# (The npm package of OpenClaw does not ship its sandbox-setup scripts, so we build it ourselves.)
# Needs network for apt inside the BUILD only; running containers have no network.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
refuse_root
command -v docker >/dev/null || die "docker not found; run scripts/wsl/20-install-docker.sh"
docker info >/dev/null 2>&1 || die "docker daemon not reachable without sudo (re-open the WSL terminal after 20-install-docker.sh)"
TAG="ferrum-sandbox:bookworm-slim"   # must match agents.defaults.sandbox.docker.image in config/ferrum.baseline.json5
docker build --pull -t "$TAG" -f "$REPO/docker/sandbox/Dockerfile" "$REPO/docker/sandbox"
hdr "Built"
docker image ls "$TAG" --format '  {{.Repository}}:{{.Tag}}  {{.Size}}  {{.ID}}'
BASEDIG="$(docker image inspect debian:bookworm-slim --format '{{index .RepoDigests 0}}' 2>/dev/null || true)"
[ -n "$BASEDIG" ] && echo "  base image digest (pin with --build-arg BASE=$BASEDIG to make rebuilds reproducible): $BASEDIG"
hdr "Smoke test (network none, read-only root, no caps)"
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges "$TAG" \
  bash -c 'echo "user=$(id -un) uid=$(id -u)"; python3 --version; rg --version | head -1; curl --version | head -1' 
ok "image works"
