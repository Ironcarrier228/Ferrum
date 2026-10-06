// `ferrum doctor`: read-only health check of the installation. Exit 1 if anything is FAIL.
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import JSON5 from "json5";
import { assessConfig } from "../check-config.mjs";
import { engineBin, engineCapture } from "./engine.mjs";
import { PKG_ROOT, SANDBOX_IMAGE, configFile, envFile, workspaceDir } from "./paths.mjs";
import { ok, warn, bad, hdr, brand } from "./ui.mjs";
import { readEnv } from "./envfile.mjs";

export function dockerStatus() {
  const info = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 20000 });
  if (info.error || info.status !== 0) return { reachable: false, image: false };
  const img = spawnSync("docker", ["image", "inspect", SANDBOX_IMAGE], { encoding: "utf8", timeout: 20000 });
  return { reachable: true, image: img.status === 0 };
}

/** Pre-flight shared by `start`: returns a list of FAIL reasons (empty = may start). */
export function preflight() {
  const fails = [];
  const cfg = configFile();
  if (!existsSync(cfg)) return [`no config: run \`ferrum setup\``];
  const viol = assessConfig(JSON5.parse(readFileSync(cfg, "utf8")));
  for (const x of viol) fails.push(`config invariant ${x.id}: ${x.why}`);
  const d = dockerStatus();
  if (!d.reachable) fails.push("docker is not reachable without sudo; the sandbox cannot start (and tools would be refused)");
  else if (!d.image) fails.push(`sandbox image missing: run \`ferrum sandbox-image\``);
  if (!existsSync(workspaceDir())) fails.push("workspace missing: run `ferrum setup`");
  return fails;
}

export async function doctor() {
  let failed = false;
  const f = (m) => { bad(m); failed = true; };

  hdr("Runtime");
  const [maj, min] = process.versions.node.split(".").map(Number);
  (maj === 24 && min >= 16) || maj >= 26 ? ok(`node ${process.versions.node}`) : f(`node ${process.versions.node}: need >=24.16 <25 or >=26.1`);
  try { const e = engineBin(); ok(`engine ${e.version} (dependency of this package)`); } catch (e) { f(e.message); }
  ok(`package: ${PKG_ROOT}`);

  hdr("Configuration");
  const cfg = configFile();
  if (!existsSync(cfg)) { f(`no config at ${cfg}: run \`ferrum setup\``); return 1; }
  const mode = statSync(cfg).mode & 0o777;
  mode === 0o600 ? ok("config mode 600") : f(`config mode is ${mode.toString(8)}, expected 600`);
  const envMode = existsSync(envFile()) ? statSync(envFile()).mode & 0o777 : null;
  envMode === 0o600 ? ok(".env mode 600") : f(`.env ${envMode === null ? "missing" : `mode ${envMode.toString(8)}`}: run \`ferrum setup\``);
  const parsed = JSON5.parse(readFileSync(cfg, "utf8"));
  const viol = assessConfig(parsed);
  if (viol.length) for (const x of viol) f(`${x.id}: ${x.why}`); else ok("all Ferrum config invariants hold");
  const env = readEnv(envFile());
  env.FERRUM_REPO === PKG_ROOT ? ok("plugin path points at this package") : f(`FERRUM_REPO in .env is ${env.FERRUM_REPO ?? "unset"}, this package is at ${PKG_ROOT}: run \`ferrum setup\``);
  existsSync(join(PKG_ROOT, "plugins", "ferrum", "openclaw.plugin.json")) ? ok("plugin files present") : f("plugin files missing in the package");
  const val = engineCapture(["config", "validate"]);
  val.status === 0 && !/warning\(s\)/.test(val.out) ? ok("engine accepts the config, no unresolved placeholders") : f("config validation:\n" + brand(val.out.split("\n").slice(0, 10).join("\n")));

  hdr("Sandbox");
  const d = dockerStatus();
  d.reachable ? ok("docker reachable") : f("docker is not reachable without sudo");
  if (d.reachable) d.image ? ok(`image ${SANDBOX_IMAGE} present`) : f(`image ${SANDBOX_IMAGE} missing: run \`ferrum sandbox-image\``);
  existsSync(workspaceDir()) ? ok(`workspace ${workspaceDir()}`) : f("workspace missing");

  hdr("Local mode (Windows folder)");
  const pc = parsed?.plugins?.entries?.ferrum?.config ?? {};
  const root = pc.localRoot ?? "D:\\Ferrum";
  const m = /^([A-Za-z]):[\\/]*(.*?)[\\/]*$/.exec(root);
  const mount = pc.localRootMount ?? (m ? `/mnt/${m[1].toLowerCase()}${m[2] ? "/" + m[2].replace(/\\/g, "/") : ""}` : root);
  existsSync(mount) ? ok(`${root} is visible at ${mount}`) : warn(`${mount} not found: create ${root} on Windows (local mode will not work until then)`);
  const ps = spawnSync("powershell.exe", ["-NoProfile", "-Command", "'ok'"], { encoding: "utf8", timeout: 20000 });
  ps.status === 0 && /ok/.test(ps.stdout ?? "") ? ok("powershell.exe works from here (WSL interop)") : warn("powershell.exe is not reachable: local_exec will not work");
  void dirname;
  console.log(failed ? "\nResult: problems found." : "\nResult: all good.");
  return failed ? 1 : 0;
}
