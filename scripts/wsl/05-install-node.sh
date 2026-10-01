#!/usr/bin/env bash
# Ferrum stage 0: install Node.js 24.x LTS for the current user (no sudo, no apt).
# Downloads the official tarball from nodejs.org and verifies it against the
# SHA-256 list published next to it. Installs to ~/.local/opt/node-vX.Y.Z and
# links ~/.local/bin/{node,npm,npx}.
#
# NOTE: written for stage 0 but NOT executed in the authoring sandbox (nodejs.org
# was unreachable there). Run it once on your WSL and report problems.
set -euo pipefail

NODE_VERSION="${1:-${NODE_VERSION:-24.21.0}}"   # must satisfy >=24.16.0 <25
[ "$(id -u)" -ne 0 ] || { echo "Do not run as root." >&2; exit 1; }

case "$(uname -m)" in
  x86_64) ARCH=x64;; aarch64|arm64) ARCH=arm64;;
  *) echo "Unsupported arch $(uname -m)" >&2; exit 1;;
esac

NAME="node-v${NODE_VERSION}-linux-${ARCH}"
BASE="https://nodejs.org/dist/v${NODE_VERSION}"
DEST="$HOME/.local/opt/node-v${NODE_VERSION}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

if [ -x "$DEST/bin/node" ]; then echo "Already installed: $DEST"; else
  echo "Downloading ${NAME}.tar.xz ..."
  curl -fsSL --proto '=https' --tlsv1.2 -o "$TMP/$NAME.tar.xz" "$BASE/$NAME.tar.xz"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$TMP/SHASUMS256.txt" "$BASE/SHASUMS256.txt"
  ( cd "$TMP" && grep " ${NAME}.tar.xz\$" SHASUMS256.txt | sha256sum -c - )
  mkdir -p "$HOME/.local/opt" "$HOME/.local/bin"
  tar -C "$TMP" -xJf "$TMP/$NAME.tar.xz"
  mv "$TMP/$NAME" "$DEST"
fi

mkdir -p "$HOME/.local/bin"
for b in node npm npx; do ln -sfn "$DEST/bin/$b" "$HOME/.local/bin/$b"; done
echo "Installed: $("$DEST/bin/node" -v) at $DEST"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Add to ~/.profile:  export PATH=\"\$HOME/.local/bin:\$PATH\"";; esac
