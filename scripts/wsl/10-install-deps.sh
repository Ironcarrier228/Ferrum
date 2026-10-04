#!/usr/bin/env bash
# Ferrum (repository checkout): install the PINNED engine dependency into ./node_modules (not global),
# then run the contract tests that check our assumptions against it.
# Does NOT run onboarding, does NOT install a gateway service, does NOT touch ~/.openclaw.
# (Installing the npm package instead: npm install -g --ignore-scripts @ironcarrier228/ferrum)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
[ "$(id -u)" -ne 0 ] || { echo "Do not run as root." >&2; exit 1; }
command -v node >/dev/null || { echo "node not found; run scripts/wsl/05-install-node.sh" >&2; exit 1; }
node -e '
  const [a,b]=process.versions.node.split(".").map(Number);
  if(!((a===24&&b>=16)||(a===26&&b>=1)||a>26)){console.error("Node "+process.versions.node+" is unsupported by the engine (need >=24.16 <25 or >=26.1)");process.exit(1)}'

PIN="$(node -p 'require("./package.json").dependencies.openclaw')"
echo "Installing engine ${PIN} (exact, lifecycle scripts disabled via .npmrc) ..."
npm ci

GOT="$(node node_modules/openclaw/openclaw.mjs --version | awk '{print $2}')"
[ "$GOT" = "$PIN" ] || { echo "Version mismatch: wanted $PIN, got $GOT" >&2; exit 1; }
echo "Engine $GOT installed in $(pwd)/node_modules"

echo "Running contract tests ..."
npm run test:contract

cat <<MSG

Next: stage 1 (Telegram + sandbox). Nothing has been configured yet:
  - ~/.openclaw does not exist unless you created it earlier
  - no gateway service installed
Use the CLI via:  node bin/ferrum.mjs <cmd>   (or: npm run ferrum -- <cmd>)
Next steps: bash scripts/wsl/40-configure.sh (= ferrum setup), then ferrum doctor, ferrum start
MSG
