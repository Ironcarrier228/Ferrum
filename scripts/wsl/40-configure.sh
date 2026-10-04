#!/usr/bin/env bash
# Store secrets in ~/.openclaw/.env (mode 600) and install the baseline config
# (thin wrapper: the logic lives in `ferrum setup`; options: --reset, --no-key).
#
# Inputs (prompted if missing; or pass as environment variables for a non-interactive run):
#   TELEGRAM_BOT_TOKEN        from @BotFather (hidden prompt)
#   FERRUM_TELEGRAM_USER_ID   your numeric Telegram user id (digits only)
#   FERRUM_MODEL_ID           model id served by your endpoint (http://localhost:20128/v1)
#   FERRUM_MODEL_API_KEY      key for that endpoint (hidden prompt; empty is allowed only with --no-key)
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
refuse_root
command -v node >/dev/null || die "node not found (scripts/wsl/05-install-node.sh)"
[ -d "$REPO/node_modules/openclaw" ] || die "dependencies not installed (scripts/wsl/10-install-deps.sh)"
exec node "$REPO/bin/ferrum.mjs" setup "$@"
