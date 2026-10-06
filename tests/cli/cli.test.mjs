// `ferrum` command: help/version, secrets handling in setup, refusals in start/doctor.
// Every child runs with a throw-away HOME and a failing `docker` shim first in PATH, so nothing real is touched
// and `ferrum start` can never launch a gateway from a test.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { engineBin } from "../../src/cli/engine.mjs";
import { validateSecrets } from "../../src/cli/setup.mjs";
import { parseEnv } from "../../src/cli/envfile.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin", "ferrum.mjs");
const TOKEN = "123456789:AAH7sKkq8d2lPzXx0Jr9wQeRtYuIoPaSdFgHj", KEY = "sk-secret-secret-secret-1234";
const GOOD = { TELEGRAM_BOT_TOKEN: TOKEN, FERRUM_TELEGRAM_USER_ID: "424242", FERRUM_MODEL_ID: "my/model-1", FERRUM_MODEL_API_KEY: KEY };

let tmp, shim;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "ferrum-cli-"));
  shim = join(tmp, "shim"); mkdirSync(shim);
  writeFileSync(join(shim, "docker"), "#!/bin/sh\necho 'docker: simulated failure' >&2\nexit 1\n", { mode: 0o755 });
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function ferrum(args, { env = {}, home } = {}) {
  const h = home ?? mkdtempSync(join(tmp, "home-"));
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env: { PATH: shim + delimiter + process.env.PATH, HOME: h, LANG: "C.UTF-8", DOCKER_HOST: "unix:///nonexistent/ferrum.sock", ...env },
    encoding: "utf8", timeout: 120000, stdin: "ignore",
  });
  return { ...r, home: h, all: `${r.stdout}${r.stderr}` };
}

test("help, version, unknown command", () => {
  const h = ferrum(["help"]); assert.equal(h.status, 0); assert.match(h.stdout, /setup \[--reset\]/);
  assert.equal(ferrum([]).status, 0);
  const v = ferrum(["version"]);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(v.status, 0); assert.match(v.stdout, new RegExp(`ferrum ${pkg.version.replace(/\./g, "\\.")}`)); assert.match(v.stdout, new RegExp(`engine ${pkg.dependencies.openclaw}`));
  const u = ferrum(["frobnicate"]); assert.equal(u.status, 2); assert.match(u.stderr, /unknown command/);
});

test("the engine is located as this package's own dependency and matches the pin", () => {
  const e = engineBin();
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(e.version, pkg.dependencies.openclaw);
  assert.ok(existsSync(e.bin));
  const r = ferrum(["engine", "--version"]); assert.equal(r.status, 0); assert.match(r.stdout, new RegExp(pkg.dependencies.openclaw));
});

test("secret shape validation", () => {
  assert.equal(validateSecrets(GOOD), null);
  for (const [k, v] of [["FERRUM_TELEGRAM_USER_ID", "@me"], ["FERRUM_TELEGRAM_USER_ID", "12"], ["TELEGRAM_BOT_TOKEN", "nope"], ["TELEGRAM_BOT_TOKEN", "123456:short"], ["FERRUM_MODEL_ID", "bad id"], ["FERRUM_MODEL_ID", ""], ["FERRUM_MODEL_API_KEY", "a$b"], ["FERRUM_MODEL_API_KEY", 'a"b'], ["FERRUM_MODEL_API_KEY", "a\nb"]]) {
    assert.ok(validateSecrets({ ...GOOD, [k]: v }), `${k}=${JSON.stringify(v)} must be rejected`);
  }
});

test("env parser never evaluates anything", () => {
  assert.deepEqual(parseEnv("A=1\nB=$(touch /tmp/pwn)\n# c\nC=x=y\nA=2\n bad=1\n"), { A: "2", B: "$(touch /tmp/pwn)", C: "x=y" });
});

test("setup: stores secrets privately, never prints them, installs the baseline config", () => {
  const r = ferrum(["setup"], { env: GOOD });
  assert.equal(r.status, 0, r.all);
  for (const secret of [TOKEN, KEY]) assert.ok(!r.all.includes(secret), "a secret was printed");
  const oc = join(r.home, ".openclaw");
  assert.equal(statSync(oc).mode & 0o777, 0o700);
  assert.equal(statSync(join(oc, ".env")).mode & 0o777, 0o600);
  assert.equal(statSync(join(oc, "openclaw.json")).mode & 0o777, 0o600);
  const env = parseEnv(readFileSync(join(oc, ".env"), "utf8"));
  assert.equal(env.TELEGRAM_BOT_TOKEN, TOKEN); assert.equal(env.FERRUM_MODEL_API_KEY, KEY);
  assert.match(env.OPENCLAW_GATEWAY_TOKEN, /^[0-9a-f]{64}$/);
  assert.equal(env.FERRUM_REPO, ROOT);
  assert.equal(readFileSync(join(oc, "openclaw.json"), "utf8"), readFileSync(join(ROOT, "config", "ferrum.baseline.json5"), "utf8"));
  assert.ok(!readFileSync(join(oc, "openclaw.json"), "utf8").includes(TOKEN));
  assert.equal(statSync(join(r.home, "ferrum", "workspace")).mode & 0o777, 0o700);
  assert.ok(!readdirSync(join(r.home, "ferrum", "workspace")).length, "workspace must start empty");
  assert.ok(!readdirSync(oc).some((f) => f.startsWith(".env.")), "no temp files left behind");

  // second run without any env: values (and the generated gateway token) are kept; other .env lines survive
  writeFileSync(join(oc, ".env"), readFileSync(join(oc, ".env"), "utf8") + "EXTRA_THING=keepme\n");
  const again = ferrum(["setup"], { home: r.home });
  assert.equal(again.status, 0, again.all);
  const env2 = parseEnv(readFileSync(join(oc, ".env"), "utf8"));
  assert.equal(env2.OPENCLAW_GATEWAY_TOKEN, env.OPENCLAW_GATEWAY_TOKEN); assert.equal(env2.EXTRA_THING, "keepme"); assert.equal(env2.FERRUM_MODEL_API_KEY, KEY);
  assert.equal(readdirSync(oc).filter((f) => f.includes(".bak.")).length, 0, "identical config must not be backed up");

  // a locally edited config is backed up, not lost
  writeFileSync(join(oc, "openclaw.json"), "// my edit\n" + readFileSync(join(oc, "openclaw.json"), "utf8"));
  const third = ferrum(["setup"], { home: r.home });
  assert.equal(third.status, 0, third.all);
  const baks = readdirSync(oc).filter((f) => f.includes(".bak."));
  assert.equal(baks.length, 1); assert.match(readFileSync(join(oc, baks[0]), "utf8"), /^\/\/ my edit/);
  assert.equal(statSync(join(oc, baks[0])).mode & 0o777, 0o600);
});

test("setup: refuses bad input and unknown options, writes no config", () => {
  for (const bad of [{ FERRUM_TELEGRAM_USER_ID: "@name" }, { TELEGRAM_BOT_TOKEN: "oops" }, { FERRUM_MODEL_API_KEY: "has$dollar" }]) {
    const r = ferrum(["setup"], { env: { ...GOOD, ...bad } });
    assert.equal(r.status, 1, r.all);
    assert.ok(!existsSync(join(r.home, ".openclaw", "openclaw.json")), "config must not be written");
    assert.ok(!r.all.includes(KEY) && !r.all.includes(TOKEN));
  }
  assert.equal(ferrum(["setup", "--wat"], { env: GOOD }).status, 1);
  const noTty = ferrum(["setup"]);
  assert.equal(noTty.status, 1); assert.match(noTty.stderr, /not set/);
});

test("setup --no-key stores the placeholder key 'none'", () => {
  const { FERRUM_MODEL_API_KEY, ...rest } = GOOD;
  const r = ferrum(["setup", "--no-key"], { env: rest });
  assert.equal(r.status, 0, r.all);
  assert.equal(parseEnv(readFileSync(join(r.home, ".openclaw", ".env"), "utf8")).FERRUM_MODEL_API_KEY, "none");
});

test("doctor and start without docker: both fail closed, start never launches the gateway", () => {
  const s = ferrum(["setup"], { env: GOOD });
  assert.equal(s.status, 0, s.all);
  const d = ferrum(["doctor"], { home: s.home });
  assert.equal(d.status, 1);
  assert.match(d.stdout, /\[ OK \] plugin path points at this package/);
  assert.match(d.stdout, /\[FAIL\] docker is not reachable/);
  const st = ferrum(["start"], { home: s.home });
  assert.equal(st.status, 1);
  assert.match(st.all, /docker is not reachable/); assert.match(st.stderr, /refusing to start/);
  assert.ok(!/Starting the gateway/.test(st.stdout));
});

test("start refuses without a config; doctor reports a tampered config", () => {
  const none = ferrum(["start"]); assert.equal(none.status, 1); assert.match(none.all, /ferrum setup/);
  const s = ferrum(["setup"], { env: GOOD });
  const cfg = join(s.home, ".openclaw", "openclaw.json");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace('mode: "all"', 'mode: "off"'), { mode: 0o600 });
  const d = ferrum(["doctor"], { home: s.home }); assert.equal(d.status, 1); assert.match(d.stdout, /sandbox\.mode/);
  const st = ferrum(["start"], { home: s.home }); assert.equal(st.status, 1); assert.match(st.all, /sandbox\.mode/);
});

test("brand(): display-only rewrite of the underlying CLI's text; paths and URLs stay intact", async () => {
  const { brand } = await import("../../src/cli/ui.mjs");
  assert.equal(brand("OpenClaw security audit"), "Ferrum security audit");
  assert.equal(brand("Run deeper: openclaw security audit --deep"), "Run deeper: ferrum engine security audit --deep");
  assert.equal(brand("~/.openclaw/openclaw.json and https://docs.openclaw.ai/x"), "~/.openclaw/openclaw.json and https://docs.openclaw.ai/x");
});

test("preflight and install-docker are listed; preflight runs the bundled read-only script", () => {
  const h = ferrum(["help"]); assert.match(h.stdout, /preflight/); assert.match(h.stdout, /install-docker/);
  const p = ferrum(["preflight"]);
  assert.match(p.stdout, /== Identity ==/);
});

test("banner: Ferrum wordmark, 'based on OpenClaw' underneath, no engine wordmark, no colour codes when colour is off", async () => {
  const { bannerLines, showBanner } = await import("../../src/cli/banner.mjs");
  const plain = bannerLines({ color: false, columns: 100 });
  assert.equal(plain.length, 10);
  assert.ok(plain.some((l) => l.includes("█▀▀▀▀ █▀▀▀▀ █▀▀▀█ █▀▀▀█ █   █ █▀▄▀█")), "wordmark FERRUM");
  const tag = plain.findIndex((l) => l.includes("based on OpenClaw"));
  assert.ok(tag > 5, "tagline under the wordmark");
  assert.ok(!plain.some((l) => l.includes("█▄  █")), "not the engine wordmark");
  assert.ok(!plain.join("\n").includes("\x1b"));
  assert.ok(bannerLines({ color: true, columns: 100 }).join("\n").includes("\x1b["));
  assert.deepEqual(bannerLines({ columns: 40 }), ["FERRUM", "based on OpenClaw"]);
  let out = ""; assert.equal(showBanner({ isTTY: false, write: (s) => (out += s) }, {}), false); assert.equal(out, "");
  assert.equal(showBanner({ isTTY: true, columns: 100, write: (s) => (out += s) }, { FERRUM_NO_BANNER: "1" }), false);
  assert.equal(showBanner({ isTTY: true, columns: 100, write: (s) => (out += s) }, { NO_COLOR: "1" }), true);
  assert.match(out, /based on OpenClaw/);
});

test("on a real terminal `ferrum` shows the banner and the grouped help; piped output has no banner", { skip: spawnSync("script", ["--version"]).error ? "script(1) not available" : false }, () => {
  const h = mkdtempSync(join(tmp, "home-"));
  const r = spawnSync("script", ["-qec", `stty cols 100; ${process.execPath} ${BIN}`, "/dev/null"], { env: { PATH: process.env.PATH, HOME: h, TERM: "xterm", COLUMNS: "100" }, encoding: "utf8", timeout: 60000 });
  assert.match(r.stdout, /█▀▀▀▀ █▀▀▀▀ █▀▀▀█/); assert.match(r.stdout, /based on OpenClaw/);
  for (const c of ["start", "status", "audit", "preflight", "install-docker", "sandbox-image", "setup", "doctor", "info", "update", "version", "engine"]) assert.match(r.stdout, new RegExp(`^\\s+${c}\\b`, "m"), c);
  const piped = ferrum([]); assert.ok(!piped.stdout.includes("█"));
  assert.match(piped.stdout, /Работа/);
});

test("audit: last N records, readable, --json, empty log, bad arguments", () => {
  const home = mkdtempSync(join(tmp, "home-")); const dir = join(home, ".ferrum", "audit"); mkdirSync(dir, { recursive: true });
  const rec = (ts, o) => JSON.stringify({ ts, ...o });
  writeFileSync(join(dir, "2026-10-04.jsonl"), [rec("2026-10-04T09:00:00.000Z", { ev: "plugin_loaded" })].join("\n") + "\n");
  writeFileSync(join(dir, "2026-10-05.jsonl"), [rec("2026-10-05T10:00:00.000Z", { ev: "tool_call", tool: "local_read", decision: "allow", params: { path: "a.txt" } }), "not json", rec("2026-10-05T10:01:00.000Z", { ev: "tool_call", tool: "local_delete", decision: "block", reason: "outside the scope" })].join("\n") + "\n");
  const r = ferrum(["audit", "2"], { home });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim().split("\n").length, 2);
  assert.match(r.stdout, /unreadable line/); assert.match(r.stdout, /local_delete block {2}\(outside the scope\)/);
  const all = ferrum(["audit", "10"], { home }); assert.match(all.stdout, /plugin_loaded/); assert.match(all.stdout, /local_read allow {2}a\.txt/);
  const j = ferrum(["audit", "1", "--json"], { home }); assert.equal(JSON.parse(j.stdout).tool, "local_delete");
  assert.match(ferrum(["audit"]).stdout, /Журнал пуст/);
  for (const bad of [["audit", "0"], ["audit", "abc"], ["audit", "--x"], ["audit", "1", "2"]]) assert.equal(ferrum(bad, { home }).status, 1, bad.join(" "));
});

test("info prints paths and versions, never secret values", () => {
  const home = mkdtempSync(join(tmp, "home-")); mkdirSync(join(home, ".openclaw"), { recursive: true });
  writeFileSync(join(home, ".openclaw", ".env"), `TELEGRAM_BOT_TOKEN=${TOKEN}\nFERRUM_MODEL_API_KEY=${KEY}\n`);
  const r = ferrum(["info"], { home });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Версия Ferrum\s+\d+\.\d+\.\d+/); assert.match(r.stdout, /D:\\Ferrum/);
  assert.ok(!r.all.includes(TOKEN) && !r.all.includes(KEY));
});

test("status: reports a stopped gateway and exits 1; never launches anything", () => {
  const r = ferrum(["status"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Ferrum не запущен/); assert.match(r.stdout, /Docker недоступен/);
});

test("update: version comparison and the check/confirm flow (fake npm)", async () => {
  const { isNewer } = await import("../../src/cli/update.mjs");
  assert.ok(isNewer("0.3.1", "0.3.0")); assert.ok(isNewer("1.0.0", "0.9.9")); assert.ok(!isNewer("0.3.0", "0.3.0")); assert.ok(!isNewer("0.2.9", "0.3.0"));
  const bin = join(tmp, "fake-npm"); mkdirSync(bin, { recursive: true });
  const log = join(tmp, "npm-calls.log"); writeFileSync(log, "");
  writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "$@" >> '${log}'\nif [ "$1" = view ]; then echo "\${FAKE_LATEST:-99.0.0}"; fi\nexit 0\n`, { mode: 0o755 });
  const env = { PATH: bin + delimiter + process.env.PATH };
  const c = ferrum(["update", "--check"], { env }); assert.equal(c.status, 0); assert.match(c.stdout, /Доступна новая версия/);
  assert.ok(!/install/.test(readFileSync(log, "utf8")), "--check must not install");
  const same = ferrum(["update", "--yes"], { env: { ...env, FAKE_LATEST: "0.0.1" } }); assert.match(same.stdout, /Обновление не нужно/);
  assert.ok(!/install/.test(readFileSync(log, "utf8")));
  const no = ferrum(["update"], { env }); assert.equal(no.status, 1); assert.match(no.stderr, /no terminal/); // refuses to guess without a terminal
  assert.ok(!/install/.test(readFileSync(log, "utf8")));
  const y = ferrum(["update", "--yes"], { env }); assert.equal(y.status, 0);
  assert.match(readFileSync(log, "utf8"), /install -g --ignore-scripts --prefer-online @ironcarrier228\/ferrum/);
  assert.equal(ferrum(["update", "--bogus"], { env }).status, 1);
});
