#!/usr/bin/env bash
# Ferrum stage 1: check that the model endpoint from ~/.openclaw/.env + config is reachable FROM WSL
# (where the gateway runs), that the model id/key work, and whether it can return tool calls.
# The key is sent only to the configured baseUrl and is never printed.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
refuse_root
BASE="http://localhost:20128/v1"   # keep in sync with config/ferrum.baseline.json5
MODEL="$(env_get FERRUM_MODEL_ID)"; KEY="$(env_get FERRUM_MODEL_API_KEY)"
[ -n "$MODEL" ] || die "FERRUM_MODEL_ID missing in $ENV_FILE (run 40-configure.sh)"
AUTH=(); [ -n "$KEY" ] && [ "$KEY" != none ] && AUTH=(-H "Authorization: Bearer $KEY")

hdr "Reachability of $BASE from WSL"
CODE="$(curl -s -m 8 -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$BASE/models" 2>/dev/null || true)"
if [ "$CODE" = 000 ] || [ -z "$CODE" ]; then
  bad "cannot connect to $BASE from WSL"
  cat <<HINT
  If the endpoint runs on WINDOWS: with WSL's default NAT networking, 'localhost' inside WSL is NOT Windows.
  Fix (Windows 11 22H2+, WSL 2.0+): create %UserProfile%\.wslconfig with
      [wsl2]
      networkingMode=mirrored
  then run 'wsl --shutdown' in PowerShell and reopen WSL. (Alternative: make the endpoint listen on
  0.0.0.0 and use the Windows host IP: $(ip route 2>/dev/null | awk '/default/ {print $3; exit}') -- then change baseUrl in the config.)
  If the endpoint runs inside WSL: check that it is started and listens on 127.0.0.1:20128.
HINT
  exit 1
fi
case "$CODE" in 2*) ok "GET /models -> HTTP $CODE";; 401|403) bad "GET /models -> HTTP $CODE: key rejected";; *) warn "GET /models -> HTTP $CODE (some gateways do not implement /models; continuing)";; esac

hdr "Chat completion with model '$MODEL'"
R="$(curl -s -m 60 "${AUTH[@]}" -H 'content-type: application/json' "$BASE/chat/completions" -d "$(printf '{"model":"%s","max_tokens":16,"messages":[{"role":"user","content":"Reply with the single word: pong"}]}' "$MODEL")" || true)"
echo "$R" | node -e '
  let t=require("fs").readFileSync(0,"utf8"); let j; try{j=JSON.parse(t)}catch{console.log("  [FAIL] not JSON: "+t.slice(0,200)); process.exit(1)}
  if(j.error){console.log("  [FAIL] endpoint error: "+JSON.stringify(j.error).slice(0,300)); process.exit(1)}
  const m=j.choices?.[0]?.message; console.log("  [ OK ] reply: "+JSON.stringify((m?.content??"").slice(0,80))+"  usage="+JSON.stringify(j.usage??{}));' || FAILED=1

hdr "Tool calling (OpenClaw agents need it)"
R="$(curl -s -m 90 "${AUTH[@]}" -H 'content-type: application/json' "$BASE/chat/completions" -d "$(printf '{"model":"%s","max_tokens":128,"tool_choice":"auto","messages":[{"role":"user","content":"Use the get_time tool to find out the time in Astana."}],"tools":[{"type":"function","function":{"name":"get_time","description":"Get current time for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]}' "$MODEL")" || true)"
echo "$R" | node -e '
  let t=require("fs").readFileSync(0,"utf8"); let j; try{j=JSON.parse(t)}catch{console.log("  [WARN] not JSON"); process.exit(0)}
  const tc=j.choices?.[0]?.message?.tool_calls;
  console.log(tc&&tc.length ? "  [ OK ] model returned a tool call: "+tc[0].function?.name+"("+String(tc[0].function?.arguments).slice(0,60)+")" : "  [WARN] no tool call returned. If the model cannot do function calling, the agent will be limited to chat (tell me; config compat.supportsTools may need to be set).");'
[ "$FAILED" -eq 0 ]
