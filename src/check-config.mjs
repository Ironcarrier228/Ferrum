// Static invariants for a Ferrum engine config (JSON5). Used by `ferrum setup|start|doctor`, by the
// contract tests, and runnable by hand:  node src/check-config.mjs ~/.openclaw/openclaw.json
// Exit 0 = all invariants hold, 1 = violations printed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";

const HOST_REACHING_PLUGINS = ["browser", "canvas", "file-transfer", "linux-node", "cua-computer", "xai", "device-pair", "admin-http-rpc", "a2a", "beam", "code-mode-quickjs", "crabbox"];
const get = (o, path) => path.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
const isPlaceholder = (v) => typeof v === "string" && /^\$\{[A-Z0-9_]+(:-[^}]*)?\}$/.test(v);

export function assessConfig(cfg) {
  const v = [];
  const need = (id, ok, why) => { if (!ok) v.push({ id, why }); };
  const sb = "agents.defaults.sandbox";

  need("gateway.bind", get(cfg, "gateway.bind") === "loopback", "gateway must listen on loopback only");
  need("gateway.auth", get(cfg, "gateway.auth.mode") === "token" && !!get(cfg, "gateway.auth.token"), "gateway auth must be token mode with a token");
  need("gateway.tools", !(get(cfg, "gateway.tools.allow") ?? []).length, "gateway.tools.allow must be empty (it re-enables exec/spawn over HTTP)");
  need("sandbox.mode", get(cfg, `${sb}.mode`) === "all", "sandbox.mode must be 'all' (default is off!)");
  need("sandbox.backend", get(cfg, `${sb}.backend`) === "docker", "sandbox backend must be docker for stage 1");
  need("sandbox.network", get(cfg, `${sb}.docker.network`) === "none", "container network must be 'none'");
  need("sandbox.readOnlyRoot", get(cfg, `${sb}.docker.readOnlyRoot`) === true, "root filesystem must be read-only");
  need("sandbox.capDrop", (get(cfg, `${sb}.docker.capDrop`) ?? []).map(String).map((x) => x.toUpperCase()).includes("ALL"), "capDrop must include ALL");
  need("sandbox.noBinds", !(get(cfg, `${sb}.docker.binds`) ?? []).length, "no extra bind mounts (only the workspace)");
  need("sandbox.noEnv", !Object.keys(get(cfg, `${sb}.docker.env`) ?? {}).length, "docker.env is visible via `docker inspect`: no secrets/env into the container");
  need("sandbox.user", !!get(cfg, `${sb}.docker.user`), "container must run as an explicit non-root uid:gid");
  need("sandbox.limits", !!get(cfg, `${sb}.docker.memory`) && !!get(cfg, `${sb}.docker.pidsLimit`), "memory and pids limits must be set");
  need("sandbox.workspace", ["rw", "ro"].includes(get(cfg, `${sb}.workspaceAccess`)) && !!get(cfg, "agents.defaults.workspace"), "workspace must be explicit and inside the Linux filesystem");
  need("sandbox.noDangerous", !JSON.stringify(get(cfg, `${sb}`) ?? {}).match(/"dangerously[A-Za-z]*":\s*true/), "no dangerously* sandbox flags");
  need("workspace.notMnt", !String(get(cfg, "agents.defaults.workspace") ?? "").startsWith("/mnt/"), "workspace must not be on /mnt/c");
  need("exec.host", get(cfg, "tools.exec.host") === "sandbox", "tools.exec.host must be 'sandbox'");
  need("elevated", get(cfg, "tools.elevated.enabled") === false, "tools.elevated.enabled must be false");
  need("acp", get(cfg, "acp.enabled") === false, "ACP runtime runs on the host: acp.enabled must be false");
  need("fs.workspaceOnly", get(cfg, "tools.fs.workspaceOnly") === true, "tools.fs.workspaceOnly must be true");
  for (const k of ["bash", "config", "debug", "plugins", "mcp", "restart"]) need(`commands.${k}`, get(cfg, `commands.${k}`) === false, `commands.${k} must be false`);
  need("telegram.dmPolicy", get(cfg, "channels.telegram.dmPolicy") === "allowlist", "telegram dmPolicy must be 'allowlist'");
  const af = get(cfg, "channels.telegram.allowFrom") ?? [];
  need("telegram.allowFrom", af.length >= 1 && !af.map(String).includes("*"), "telegram allowFrom must list explicit user ids, never '*'");
  need("telegram.groupPolicy", get(cfg, "channels.telegram.groupPolicy") !== "open", "telegram groupPolicy must not be 'open'");
  need("telegram.configWrites", get(cfg, "channels.telegram.configWrites") === false, "chat must not be able to write config (hot reload would apply it, even sandbox.mode)");
  const allow = get(cfg, "plugins.allow");
  need("plugins.allow", Array.isArray(allow) && allow.length > 0, "plugins.allow must be an explicit list (41 plugins are on by default)");
  need("plugins.noHostReaching", !(allow ?? []).some((p) => HOST_REACHING_PLUGINS.includes(p)), `plugins.allow must not contain ${HOST_REACHING_PLUGINS.join("/")}`);
  need("timeout", Number(get(cfg, "agents.defaults.timeoutSeconds")) > 0 && Number(get(cfg, "agents.defaults.timeoutSeconds")) <= 3600, "agents.defaults.timeoutSeconds must be set (default is 48 h)");
  for (const p of ["gateway.auth.token", "channels.telegram.botToken", "models.providers.custom.apiKey"]) {
    need(`secret.${p}`, isPlaceholder(get(cfg, p)), `${p} must be a \${ENV} placeholder, not a literal secret`);
  }
  return v;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) { console.error("usage: node src/check-config.mjs <config.json5>"); process.exit(2); }
  const viol = assessConfig(JSON5.parse(readFileSync(path, "utf8")));
  if (viol.length) { for (const x of viol) console.log(`  [FAIL] ${x.id}: ${x.why}`); process.exit(1); }
  console.log("  [ OK ] all Ferrum config invariants hold");
}
