#!/usr/bin/env bash
# Ferrum stage 1: native Docker Engine inside WSL (no Docker Desktop), from the Ubuntu
# archive (package docker.io). Needs sudo. Idempotent.
#
# Security note: membership of the `docker` group is root-equivalent INSIDE THIS WSL
# DISTRO (anyone who can talk to the daemon can mount / as root). That is why Ferrum
# (a) never mounts docker.sock into the sandbox, (b) uses a dedicated distro, and
# (c) the gateway is the only process that talks to Docker. Rootless Docker would be
# stricter but is fragile on WSL; revisit in stage 6 if wanted.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
refuse_root
. /etc/os-release
[ "${ID:-}" = ubuntu ] || warn "tested on Ubuntu 24.04 only (this is ${PRETTY_NAME:-unknown})"
[ -d /run/systemd/system ] || die "systemd is not running. Add to /etc/wsl.conf:  [boot]  systemd=true  then run 'wsl --shutdown' in PowerShell and reopen."

hdr "Plan (nothing else is changed)"
cat <<PLAN
  sudo apt-get install docker.io (+ docker-buildx if the archive has it)
  sudo systemctl enable --now docker
  sudo usermod -aG docker $USER     # root-equivalent in this distro, see header
Disk: roughly 300-400 MB for the engine.
PLAN
if [ "${1:-}" != "--yes" ]; then
  read -r -p "Proceed? [y/N] " a; [ "$a" = y ] || [ "$a" = Y ] || die "aborted"
fi

sudo apt-get update
sudo apt-get install -y --no-install-recommends docker.io
if apt-cache show docker-buildx >/dev/null 2>&1; then sudo apt-get install -y --no-install-recommends docker-buildx || true; fi
sudo systemctl enable --now docker
getent group docker | grep -qw "$USER" || sudo usermod -aG docker "$USER"

hdr "Verify"
# the new group is not active in this shell yet: use sg
if sg docker -c 'docker info --format "{{.ServerVersion}}"' >/tmp/ferrum-docker-ver 2>/dev/null; then
  ok "docker daemon reachable, server $(cat /tmp/ferrum-docker-ver)"
else
  bad "docker daemon not reachable (journalctl -u docker --no-pager | tail)"
fi
rm -f /tmp/ferrum-docker-ver
echo
echo "IMPORTANT: your current shell does not have the docker group yet. Run in PowerShell:"
echo "    wsl --terminate <your distro>      (then reopen the terminal)"
echo "and check:  docker info   (must work WITHOUT sudo)."
[ "$FAILED" -eq 0 ]
