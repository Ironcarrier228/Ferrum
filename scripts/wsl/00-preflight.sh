#!/usr/bin/env bash
# Ferrum stage 0: read-only preflight, run INSIDE WSL2 (Ubuntu 24.04) as a normal user.
# Changes nothing. Exit code 1 if any hard requirement fails.
set -u

PASS=0; WARN=0; FAIL=0
ok()   { printf '  [ OK ] %s\n' "$*"; PASS=$((PASS+1)); }
warn() { printf '  [WARN] %s\n' "$*"; WARN=$((WARN+1)); }
bad()  { printf '  [FAIL] %s\n' "$*"; FAIL=$((FAIL+1)); }
hdr()  { printf '\n== %s ==\n' "$*"; }

version_ge() { # version_ge 24.21.0 24.16.0  -> true if $1 >= $2
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

hdr "Identity"
if [ "$(id -u)" -eq 0 ]; then bad "running as root; Gateway must run as a normal user"; else ok "user: $(id -un) (uid $(id -u))"; fi

hdr "WSL2 / OS"
if grep -qi microsoft /proc/version 2>/dev/null; then ok "running under WSL"; else warn "not WSL (Linux native? fine for stage 8, not for Windows topology)"; fi
if grep -qi 'WSL2' /proc/version 2>/dev/null || [ -n "${WSL_INTEROP:-}" ]; then ok "WSL2 kernel / interop socket present"; else warn "cannot confirm WSL2 (WSL1 does not run Docker/systemd properly)"; fi
. /etc/os-release 2>/dev/null
if [ "${ID:-}" = "ubuntu" ] && [ "${VERSION_ID:-}" = "24.04" ]; then ok "Ubuntu 24.04"; else warn "distro is ${PRETTY_NAME:-unknown}; Ferrum targets Ubuntu 24.04"; fi

hdr "systemd (needed for the gateway service and autostart)"
if [ "$(ps -p 1 -o comm= 2>/dev/null)" = "systemd" ]; then ok "PID 1 is systemd"; else bad "systemd is not PID 1; add [boot]\\nsystemd=true to /etc/wsl.conf and run 'wsl --shutdown' from Windows"; fi
if systemctl --user status >/dev/null 2>&1; then ok "systemd --user reachable"; else warn "systemctl --user not reachable (no user session yet?)"; fi

hdr "Node.js (the engine requires >=24.16.0 <25 or >=26.1.0)"
if command -v node >/dev/null 2>&1; then
  NV="$(node -p 'process.versions.node')"
  MAJ="${NV%%.*}"
  if { [ "$MAJ" = "24" ] && version_ge "$NV" 24.16.0; } || { [ "$MAJ" -ge 26 ] 2>/dev/null && version_ge "$NV" 26.1.0; }; then
    ok "node $NV"
  else
    bad "node $NV does not satisfy the engine requirements; run scripts/wsl/05-install-node.sh"
  fi
else
  bad "node not found; run scripts/wsl/05-install-node.sh"
fi
command -v npm >/dev/null 2>&1 && ok "npm $(npm -v)" || bad "npm not found"
command -v git >/dev/null 2>&1 && ok "git $(git --version | cut -d' ' -f3)" || warn "git not found"

hdr "Container runtime for the sandbox (Docker Desktop is NOT required)"
# Sandbox backends: docker | podman (both built in). Docker Desktop, a native
# Docker Engine inside WSL, and rootless Podman are all acceptable. Podman cannot run
# the sandboxed *browser* (Docker engine only); everything else is identical.
RT=""
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  RT=docker
  ok "docker daemon reachable: $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
  if docker info 2>/dev/null | grep -qi 'Docker Desktop'; then ok "daemon is Docker Desktop"; else ok "daemon is a native Docker Engine"; fi
  ok "reminder: never bind-mount /var/run/docker.sock into the sandbox"
elif command -v docker >/dev/null 2>&1; then
  warn "docker CLI present but daemon unreachable (start it, or use podman)"
fi
if command -v podman >/dev/null 2>&1; then
  if podman info >/dev/null 2>&1; then
    [ -z "$RT" ] && RT=podman
    ok "podman works rootless: $(podman --version | cut -d' ' -f3)"
  else
    warn "podman installed but 'podman info' fails (subuid/subgid? run: grep \"^$(id -un):\" /etc/subuid /etc/subgid)"
  fi
fi
if [ -z "$RT" ]; then
  bad "no working container runtime. Light option without Docker Desktop: sudo apt-get install -y podman (then re-run)"
else
  ok "sandbox backend candidate: $RT"
fi

hdr "Disk space (stage-0 footprint estimate ~3.3-4.2 GB; recommend >= 8 GB free)"
# Rough sizes: WSL Ubuntu 24.04 ~1.5-2 GB, Node ~0.25, engine node_modules ~0.72 (measured),
# container engine ~0.15-0.3, sandbox image ~0.4. WSL's virtual disk never shrinks by itself.
FREE_KB="$(df -Pk "$HOME" | awk 'NR==2{print $4}')"
FREE_GB="$(awk -v k="$FREE_KB" 'BEGIN{printf "%.1f", k/1048576}')"
if   [ "$FREE_KB" -lt 2097152 ]; then bad  "only ${FREE_GB} GB free in WSL \$HOME filesystem"
elif [ "$FREE_KB" -lt 8388608 ]; then warn "${FREE_GB} GB free in WSL \$HOME filesystem (tight; sessions, logs and image layers grow)"
else ok "${FREE_GB} GB free in WSL \$HOME filesystem"; fi
if command -v powershell.exe >/dev/null 2>&1; then
  CFREE="$(powershell.exe -NoProfile -NonInteractive -Command '[math]::Round((Get-PSDrive C).Free/1GB,1)' 2>/dev/null | tr -d '\r')"
  [ -n "$CFREE" ] && printf '  [INFO] Windows C: free space: %s GB (the WSL virtual disk lives here unless relocated)\n' "$CFREE"
fi

hdr "Workspace location (must be on the WSL ext4 filesystem, not /mnt/c)"
WS="${FERRUM_WORKSPACE:-$HOME/ferrum/workspace}"
case "$(readlink -f "$HOME")" in /mnt/*) bad "HOME is on a Windows drive: $HOME";; *) ok "HOME is on the Linux filesystem: $HOME";; esac
case "$WS" in /mnt/*) bad "sandbox workspace $WS is under /mnt (slow and exposes Windows files)";; *) ok "sandbox workspace will be $WS";; esac

hdr "Windows interop (needed only for LOCAL mode; sandbox mode works without it)"
if command -v powershell.exe >/dev/null 2>&1; then
  ok "powershell.exe on PATH"
  WIN_USER="$(powershell.exe -NoProfile -NonInteractive -Command '$env:USERNAME' 2>/dev/null | tr -d '\r')"
  [ -n "$WIN_USER" ] && ok "Windows user seen through interop: $WIN_USER" || warn "powershell.exe returned nothing (interop disabled in /etc/wsl.conf?)"
  # Stage 2 depends on this: interop children must NOT be elevated.
  ELEV="$(powershell.exe -NoProfile -NonInteractive -Command '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)' 2>/dev/null | tr -d '\r')"
  case "$ELEV" in
    False) ok "interop PowerShell is NOT elevated";;
    True)  bad "interop PowerShell IS ELEVATED (WSL was started from an Administrator terminal). Run 'wsl --shutdown' and restart WSL from a normal terminal; local mode must never run elevated";;
    *)     warn "could not determine elevation (got '$ELEV')";;
  esac
  UP="$(powershell.exe -NoProfile -NonInteractive -Command '$env:USERPROFILE' 2>/dev/null | tr -d '\r')"
  [ -n "$UP" ] && ok "USERPROFILE = $UP  (default local workspace: $UP\\ferrum-workspace)"
else
  warn "powershell.exe not reachable: local mode would be unavailable (check [interop] enabled=true in /etc/wsl.conf)"
fi
[ -d /mnt/c ] && ok "/mnt/c is mounted (policy must treat it as the Windows filesystem)" || ok "/mnt/c not mounted"

hdr "Gateway port (must stay on loopback)"
if ss -ltn 2>/dev/null | grep -q ':18789 '; then warn "something already listens on :18789"; else ok "port 18789 free"; fi

hdr "Summary"
printf '  pass=%s warn=%s fail=%s\n' "$PASS" "$WARN" "$FAIL"
[ "$FAIL" -eq 0 ]
