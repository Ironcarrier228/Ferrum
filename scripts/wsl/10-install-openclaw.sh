#!/usr/bin/env bash
# Ferrum stage 0: install the PINNED OpenClaw as a project dependency (not global),
# then run the contract tests that check our assumptions against it.
# Does NOT run onboarding, does NOT install the gateway service, does NOT touch ~/.openclaw.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
[ "$(id -u)" -ne 0 ] || { echo "Do not run as root." >&2; exit 1; }
command -v node >/dev/null || { echo "node not found; run scripts/wsl/05-install-node.sh" >&2; exit 1; }
node -e '
  const [a,b]=process.versions.node.split(".").map(Number);
  if(!((a===24&&b>=16)||(a===26&&b>=1)||a>26)){console.error("Node "+process.versions.node+" is unsupported by OpenClaw (need >=24.16 <25 or >=26.1)");process.exit(1)}'

PIN="$(node -p 'require("./package.json").dependencies.openclaw')"
echo "Installing openclaw@${PIN} (exact, lifecycle scripts disabled via .npmrc) ..."
npm ci

GOT="$(node node_modules/openclaw/openclaw.mjs --version | awk '{print $2}')"
[ "$GOT" = "$PIN" ] || { echo "Version mismatch: wanted $PIN, got $GOT" >&2; exit 1; }
echo "OpenClaw $GOT installed in $(pwd)/node_modules"

echo "Running contract tests ..."
npm run test:contract

cat <<MSG

Next: stage 1 (Telegram + sandbox). Nothing has been configured yet:
  - ~/.openclaw does not exist unless you created it earlier
  - no gateway service installed
Use the pinned CLI via:  npx openclaw <cmd>   (or: npm run openclaw -- <cmd>)
MSG
