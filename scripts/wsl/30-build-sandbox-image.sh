#!/usr/bin/env bash
# Build the sandbox image (thin wrapper: the logic lives in `ferrum sandbox-image`).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
refuse_root
command -v node >/dev/null || die "node not found (scripts/wsl/05-install-node.sh)"
exec node "$REPO/bin/ferrum.mjs" sandbox-image "$@"
