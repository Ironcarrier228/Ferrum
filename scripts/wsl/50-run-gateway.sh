#!/usr/bin/env bash
# Run the gateway in the FOREGROUND (Ctrl+C stops it); thin wrapper around `ferrum start`.
# The autostart service comes in a later stage.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
refuse_root
export PATH="$HOME/.local/bin:$PATH"
exec node "$REPO/bin/ferrum.mjs" start
