// End-to-end check of the PUBLISHABLE artifact: npm pack -> install the tarball into an empty prefix
// (with lifecycle scripts disabled, as the README tells users) -> run `ferrum` from there, and run the
// integration test (real gateway + fake model) against the installed copy.
// Needs network access to the npm registry (to install the pinned dependencies). ~2-3 min.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const T = mkdtempSync(join(tmpdir(), "ferrum-install-"));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? "\n       " + String(detail).slice(0, 800) : ""}`); };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });

try {
  console.log(`install check in ${T}`);
  const packed = sh("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", T], { cwd: ROOT });
  check("npm pack", packed.status === 0, packed.stderr);
  const tarball = join(T, JSON.parse(packed.stdout)[0].filename);
  const prefix = join(T, "prefix");
  const inst = sh("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", tarball]);
  check("npm install of the tarball (scripts disabled)", inst.status === 0, inst.stdout + inst.stderr);
  const pkgDir = join(prefix, "node_modules", "@ironcarrier228", "ferrum");
  const ferrum = join(prefix, "node_modules", ".bin", "ferrum");
  const engine = join(prefix, "node_modules", ".bin", "openclaw");
  check("package directory and bin link exist", existsSync(join(pkgDir, "package.json")) && existsSync(ferrum));
  check("installed package ships no tests or private files", !existsSync(join(pkgDir, "tests")) && !existsSync(join(pkgDir, ".env")) && !existsSync(join(pkgDir, "package-lock.json")));

  const home = join(T, "home");
  const shim = join(T, "shim"); sh("mkdir", ["-p", shim, home]);
  sh("sh", ["-c", `printf '#!/bin/sh\\nexit 1\\n' > ${shim}/docker && chmod +x ${shim}/docker`]);
  const env = { PATH: shim + delimiter + process.env.PATH, HOME: home, LANG: "C.UTF-8", DOCKER_HOST: "unix:///nonexistent/x.sock",
    TELEGRAM_BOT_TOKEN: "123456789:AAH7sKkq8d2lPzXx0Jr9wQeRtYuIoPaSdFgHj", FERRUM_TELEGRAM_USER_ID: "424242", FERRUM_MODEL_ID: "m/1", FERRUM_MODEL_API_KEY: "k-secret-value" };

  const v = sh(ferrum, ["version"], { env });
  check("ferrum version prints ferrum + engine versions", v.status === 0 && /^ferrum \d/m.test(v.stdout) && /^engine 2026\./m.test(v.stdout), v.stdout + v.stderr);
  const s = sh(ferrum, ["setup"], { env, timeout: 180000 });
  check("ferrum setup succeeds from the installed package", s.status === 0, s.stdout + s.stderr);
  check("setup printed no secret", !(s.stdout + s.stderr).includes(env.FERRUM_MODEL_API_KEY) && !(s.stdout + s.stderr).includes(env.TELEGRAM_BOT_TOKEN));
  const dotenv = existsSync(join(home, ".openclaw", ".env")) ? readFileSync(join(home, ".openclaw", ".env"), "utf8") : "";
  check("FERRUM_REPO points at the installed package", dotenv.split("\n").includes(`FERRUM_REPO=${realpathSync(pkgDir)}`), dotenv.replace(/=.*/g, "=…"));
  check(".env mode 600", existsSync(join(home, ".openclaw", ".env")) && (statSync(join(home, ".openclaw", ".env")).mode & 0o777) === 0o600);
  const d = sh(ferrum, ["doctor"], { env, timeout: 180000 });
  const fails = d.stdout.split("\n").filter((l) => l.includes("[FAIL]"));
  check("ferrum doctor: the only failure is docker (absent by design here)", fails.length === 1 && /docker/.test(fails[0]), d.stdout);
  check("ferrum doctor: plugin path and engine are fine", /\[ OK \] plugin path points at this package/.test(d.stdout) && /\[ OK \] engine 2026\./.test(d.stdout));
  const st = sh(ferrum, ["start"], { env, timeout: 60000 });
  check("ferrum start refuses without docker", st.status === 1 && /refusing to start/.test(st.stderr));

  console.log("\nintegration test against the installed package:");
  const it = sh(process.execPath, [join(ROOT, "tests", "integration", "run.mjs")], { env: { ...process.env, FERRUM_PKG_DIR: realpathSync(pkgDir), FERRUM_ENGINE_BIN: engine }, timeout: 600000 });
  const tail = (it.stdout + it.stderr).split("\n").filter((l) => /FAIL|passed|HARNESS/.test(l)).join("\n");
  check("integration test passes against the installed package", it.status === 0, tail || it.stdout + it.stderr);
  console.log(tail);
} finally {
  rmSync(T, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
