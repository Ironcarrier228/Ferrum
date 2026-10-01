# shared helpers for Ferrum WSL scripts (sourced, not executed)
ok()   { printf '  [ OK ] %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*"; }
bad()  { printf '  [FAIL] %s\n' "$*"; FAILED=1; }
hdr()  { printf '\n== %s ==\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
FAILED=0
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OC_HOME="${OPENCLAW_HOME_DIR:-$HOME/.openclaw}"
ENV_FILE="$OC_HOME/.env"
refuse_root() { [ "$(id -u)" -ne 0 ] || die "do not run as root (use your normal WSL user)"; }
# env_get KEY: print a value from ~/.openclaw/.env (never sourced, so no shell injection)
env_get() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
oc() { ( cd "$REPO" && node_modules/.bin/openclaw "$@" ); }
