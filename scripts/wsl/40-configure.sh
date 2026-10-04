#!/usr/bin/env bash
# Ferrum stage 1: create ~/.openclaw/openclaw.json from config/ferrum.baseline.json5 and put the
# secrets into ~/.openclaw/.env (mode 600). Secrets are never written into the config, the repo,
# or the agent workspace, and are never echoed.
#
# Inputs (prompted if missing; or pass as environment variables for a non-interactive run):
#   TELEGRAM_BOT_TOKEN        from @BotFather (hidden prompt)
#   FERRUM_TELEGRAM_USER_ID   your numeric Telegram user id (digits only)
#   FERRUM_MODEL_ID           model id served by your endpoint (http://localhost:20128/v1)
#   FERRUM_MODEL_API_KEY      key for that endpoint (hidden prompt; empty is allowed only with --no-key)
# Existing values in ~/.openclaw/.env are kept; use --reset to re-enter everything.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
refuse_root
command -v node >/dev/null || die "node not found (scripts/wsl/05-install-node.sh)"
[ -x "$REPO/node_modules/.bin/openclaw" ] || die "OpenClaw not installed (scripts/wsl/10-install-openclaw.sh)"

RESET=0; NOKEY=0
for a in "$@"; do case "$a" in --reset) RESET=1;; --no-key) NOKEY=1;; *) die "unknown option $a";; esac; done

umask 077
mkdir -p "$OC_HOME"; chmod 700 "$OC_HOME"
mkdir -p "$HOME/ferrum/workspace"; chmod 700 "$HOME/ferrum" "$HOME/ferrum/workspace"
[ "$RESET" -eq 1 ] && : > "$ENV_FILE"
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"

declare -A V
for k in TELEGRAM_BOT_TOKEN FERRUM_TELEGRAM_USER_ID FERRUM_MODEL_ID FERRUM_MODEL_API_KEY OPENCLAW_GATEWAY_TOKEN; do
  cur="$(env_get "$k")"; [ -n "$cur" ] || cur="${!k:-}"; V[$k]="$cur"
done
ask() { # ask KEY "prompt" secret(0/1)
  local k="$1" p="$2" s="$3" val
  [ -n "${V[$k]}" ] && return 0
  [ -t 0 ] || die "$k is not set and there is no terminal to ask on"
  if [ "$s" = 1 ]; then read -r -s -p "$p: " val; echo; else read -r -p "$p: " val; fi
  V[$k]="$val"
}
ask TELEGRAM_BOT_TOKEN "Telegram bot token (hidden)" 1
ask FERRUM_TELEGRAM_USER_ID "Your numeric Telegram user id" 0
ask FERRUM_MODEL_ID "Model id on http://localhost:20128/v1" 0
[ "$NOKEY" -eq 1 ] || ask FERRUM_MODEL_API_KEY "API key for the model endpoint (hidden)" 1
[ -n "${V[OPENCLAW_GATEWAY_TOKEN]}" ] || V[OPENCLAW_GATEWAY_TOKEN]="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
[ "$NOKEY" -eq 1 ] && [ -z "${V[FERRUM_MODEL_API_KEY]}" ] && V[FERRUM_MODEL_API_KEY]="none"

# validate shapes without printing values
[[ "${V[FERRUM_TELEGRAM_USER_ID]}" =~ ^[0-9]{5,15}$ ]] || die "FERRUM_TELEGRAM_USER_ID must be digits only (a numeric id, not @username)"
[[ "${V[TELEGRAM_BOT_TOKEN]}" =~ ^[0-9]{5,}:[A-Za-z0-9_-]{20,}$ ]] || die "TELEGRAM_BOT_TOKEN does not look like <digits>:<token>"
[[ "${V[FERRUM_MODEL_ID]}" =~ ^[A-Za-z0-9._:/@+-]+$ ]] || die "FERRUM_MODEL_ID has unexpected characters"
for k in FERRUM_MODEL_API_KEY; do [[ "${V[$k]}" != *$'\n'* && "${V[$k]}" != *'$'* && "${V[$k]}" != *'"'* ]] || die "$k contains characters that are unsafe in a ${ENV_FILE##*/} file (newline, \$ or \")"; done

# rewrite .env atomically: our keys + whatever else was there
TMP="$(mktemp "$OC_HOME/.env.XXXXXX")"
{
  for k in TELEGRAM_BOT_TOKEN FERRUM_TELEGRAM_USER_ID FERRUM_MODEL_ID FERRUM_MODEL_API_KEY OPENCLAW_GATEWAY_TOKEN; do printf '%s=%s\n' "$k" "${V[$k]}"; done
  printf 'FERRUM_SANDBOX_UID=%s\nFERRUM_SANDBOX_GID=%s\nFERRUM_REPO=%s\n' "$(id -u)" "$(id -g)" "$REPO"
  grep -Ev '^(TELEGRAM_BOT_TOKEN|FERRUM_TELEGRAM_USER_ID|FERRUM_MODEL_ID|FERRUM_MODEL_API_KEY|OPENCLAW_GATEWAY_TOKEN|FERRUM_SANDBOX_UID|FERRUM_SANDBOX_GID|FERRUM_REPO)=' "$ENV_FILE" || true
} > "$TMP"
chmod 600 "$TMP"; mv "$TMP" "$ENV_FILE"
ok "secrets stored in $ENV_FILE (mode 600, outside the workspace)"

CFG="$OC_HOME/openclaw.json"
if [ -f "$CFG" ] && ! cmp -s "$CFG" "$REPO/config/ferrum.baseline.json5"; then
  cp -p "$CFG" "$CFG.bak.$(date +%Y%m%d-%H%M%S)"; warn "existing config backed up next to it"
fi
cp "$REPO/config/ferrum.baseline.json5" "$CFG"; chmod 600 "$CFG"
ok "config installed: $CFG (copy of config/ferrum.baseline.json5, placeholders only)"

hdr "Checks"
node "$REPO/scripts/check-config.mjs" "$CFG" || FAILED=1
VOUT="$(oc config validate 2>&1)" || FAILED=1
echo "$VOUT" | head -12
# unresolved ${VAR} placeholders are only warnings in OpenClaw ("feature will be unavailable"): treat them as failures
if echo "$VOUT" | grep -q "warning(s)"; then bad "config has unresolved placeholders/warnings (see above)"; fi
echo "-- sandbox explain (what OpenClaw itself says about this config):"
oc sandbox explain --json | node -e '
  const e=JSON.parse(require("fs").readFileSync(0,"utf8")); const s=e.sandbox;
  console.log("  mode="+s.mode+" backend="+s.backend+" sessionIsSandboxed="+s.sessionIsSandboxed+" elevated="+e.elevated.enabled);
  for (const m of s.workspaceMounts) console.log("  mount: "+m.hostRoot+" -> "+m.containerRoot+(m.writable?" (rw)":" (ro)"));'
echo "-- openclaw security audit:"
oc security audit || true
[ "$FAILED" -eq 0 ] && ok "configuration ready. Next: scripts/wsl/45-check-model.sh, then scripts/wsl/50-run-gateway.sh" || bad "see FAIL lines above"
[ "$FAILED" -eq 0 ]
