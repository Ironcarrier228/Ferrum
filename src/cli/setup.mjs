// `ferrum setup`: put secrets into ~/.openclaw/.env (mode 600) and install the baseline config.
// Secrets are never written into the config, the package, or the agent workspace, and are never echoed.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import JSON5 from "json5";
import { assessConfig } from "../check-config.mjs";
import { engineCapture } from "./engine.mjs";
import { BASELINE, PKG_ROOT, stateDir, envFile, configFile, workspaceDir } from "./paths.mjs";
import { ask, ok, warn, bad, hdr, die, brand } from "./ui.mjs";
import { readEnv } from "./envfile.mjs";

const KEYS = ["TELEGRAM_BOT_TOKEN", "FERRUM_TELEGRAM_USER_ID", "FERRUM_MODEL_ID", "FERRUM_MODEL_API_KEY", "OPENCLAW_GATEWAY_TOKEN"];
const OWN = [...KEYS, "FERRUM_SANDBOX_UID", "FERRUM_SANDBOX_GID", "FERRUM_REPO"];

/** Validate shapes without printing values. Returns an error string or null. */
export function validateSecrets(v) {
  if (!/^[0-9]{5,15}$/.test(v.FERRUM_TELEGRAM_USER_ID ?? "")) return "FERRUM_TELEGRAM_USER_ID must be digits only (a numeric id, not @username)";
  if (!/^[0-9]{5,}:[A-Za-z0-9_-]{20,}$/.test(v.TELEGRAM_BOT_TOKEN ?? "")) return "TELEGRAM_BOT_TOKEN does not look like <digits>:<token>";
  if (!/^[A-Za-z0-9._:/@+-]+$/.test(v.FERRUM_MODEL_ID ?? "")) return "FERRUM_MODEL_ID has unexpected characters";
  if (/[\n\r$"]/.test(v.FERRUM_MODEL_API_KEY ?? "")) return "FERRUM_MODEL_API_KEY contains characters that are unsafe in a .env file (newline, $ or \")";
  return null;
}

export async function setup(args) {
  const reset = args.includes("--reset"), noKey = args.includes("--no-key");
  for (const a of args) if (!["--reset", "--no-key"].includes(a)) die(`unknown option ${a}`);
  if (typeof process.getuid === "function" && process.getuid() === 0) die("do not run as root (use your normal user)");

  mkdirSync(stateDir(), { recursive: true, mode: 0o700 }); chmodSync(stateDir(), 0o700);
  mkdirSync(workspaceDir(), { recursive: true, mode: 0o700 });
  chmodSync(join(workspaceDir(), ".."), 0o700); chmodSync(workspaceDir(), 0o700);
  const file = envFile();
  if (reset && existsSync(file)) writeFileSync(file, "", { mode: 0o600 });
  if (!existsSync(file)) writeFileSync(file, "", { mode: 0o600 });
  chmodSync(file, 0o600);

  const old = readEnv(file);
  const V = {};
  for (const k of KEYS) V[k] = old[k] || process.env[k] || "";
  const prompts = [
    ["TELEGRAM_BOT_TOKEN", "Telegram bot token (hidden)", true],
    ["FERRUM_TELEGRAM_USER_ID", "Your numeric Telegram user id", false],
    ["FERRUM_MODEL_ID", "Model id on http://localhost:20128/v1", false],
    ...(noKey ? [] : [["FERRUM_MODEL_API_KEY", "API key for the model endpoint (hidden)", true]]),
  ];
  for (const [k, p, secret] of prompts) if (!V[k]) V[k] = (await ask(p, { secret }).catch((e) => die(`${k} is not set and cannot be asked: ${e.message}`))).trim();
  if (!V.OPENCLAW_GATEWAY_TOKEN) V.OPENCLAW_GATEWAY_TOKEN = randomBytes(32).toString("hex");
  if (noKey && !V.FERRUM_MODEL_API_KEY) V.FERRUM_MODEL_API_KEY = "none";

  const err = validateSecrets(V);
  if (err) die(err);

  // rewrite .env atomically: our keys + whatever else was there
  const keep = readFileSync(file, "utf8").split("\n").filter((l) => l && !OWN.some((k) => l.startsWith(`${k}=`)));
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000, gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  const lines = [...KEYS.map((k) => `${k}=${V[k]}`), `FERRUM_SANDBOX_UID=${uid}`, `FERRUM_SANDBOX_GID=${gid}`, `FERRUM_REPO=${PKG_ROOT}`, ...keep];
  const tmp = join(stateDir(), `.env.${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600); renameSync(tmp, file);
  ok(`secrets stored in ${file} (mode 600, outside the workspace)`);

  const cfg = configFile();
  const base = readFileSync(BASELINE, "utf8");
  if (existsSync(cfg) && readFileSync(cfg, "utf8") !== base) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    copyFileSync(cfg, `${cfg}.bak.${stamp}`); chmodSync(`${cfg}.bak.${stamp}`, 0o600);
    warn("existing config backed up next to it");
  }
  writeFileSync(cfg, base, { mode: 0o600 }); chmodSync(cfg, 0o600);
  ok(`config installed: ${cfg} (copy of the baseline, placeholders only)`);

  hdr("Checks");
  let failed = false;
  const viol = assessConfig(JSON5.parse(readFileSync(cfg, "utf8")));
  if (viol.length) { for (const x of viol) bad(`${x.id}: ${x.why}`); failed = true; } else ok("all Ferrum config invariants hold");
  const val = engineCapture(["config", "validate"]);
  console.log(brand(val.out.split("\n").slice(0, 12).join("\n")));
  if (val.status !== 0) failed = true;
  // unresolved ${VAR} placeholders are only warnings in the engine ("feature will be unavailable"): treat as failure
  if (/warning\(s\)/.test(val.out)) { bad("config has unresolved placeholders/warnings (see above)"); failed = true; }
  const ex = engineCapture(["sandbox", "explain", "--json"]);
  try {
    const e = JSON.parse(ex.stdout.slice(ex.stdout.indexOf("{"))); const s = e.sandbox;
    console.log(`-- sandbox explain: mode=${s.mode} backend=${s.backend} sessionIsSandboxed=${s.sessionIsSandboxed} elevated=${e.elevated.enabled}`);
    for (const m of s.workspaceMounts) console.log(`   mount: ${m.hostRoot} -> ${m.containerRoot}${m.writable ? " (rw)" : " (ro)"}`);
  } catch { warn("could not read `sandbox explain`"); failed = true; }
  const sec = engineCapture(["security", "audit"]);
  console.log("-- security audit:\n" + brand(sec.out.trimEnd()));
  if (failed) { bad("see FAIL lines above"); return 1; }
  ok("configuration ready. Next: ferrum doctor, then ferrum start");
  return 0;
}
void statSync;
