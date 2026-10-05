// What `npm publish` would ship: the right files, nothing private, no install-time code execution.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const pack = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8" }))[0];
const files = pack.files.map((f) => f.path);

test("package identity", () => {
  assert.equal(pkg.name, "@ironcarrier228/ferrum");
  assert.notEqual(pkg.private, true, "a private package cannot be published");
  assert.equal(pkg.license, "GPL-3.0-or-later");
  assert.equal(pkg.publishConfig.access, "public");
  assert.deepEqual(pkg.bin, { ferrum: "bin/ferrum.mjs" });
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test("dependencies are exact pins (no ranges) and cover everything the code imports", () => {
  for (const [n, v] of Object.entries(pkg.dependencies)) assert.match(v, /^\d+\.\d+\.\d+$/, `${n}@${v} must be an exact version`);
  for (const need of ["openclaw", "json5", "typebox"]) assert.ok(pkg.dependencies[need], `missing dependency ${need}`);
  assert.equal(pkg.devDependencies, undefined, "runtime code must not need devDependencies");
});

test("no install-time scripts that would run on the user's machine", () => {
  for (const k of ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack"]) assert.equal(pkg.scripts?.[k], undefined, `scripts.${k}`);
});

test("shipped files: everything needed is there", () => {
  for (const f of ["package.json", "LICENSE", "README.md", "bin/ferrum.mjs", "src/check-config.mjs", "src/cli/main.mjs", "src/cli/setup.mjs", "src/cli/doctor.mjs", "src/cli/start.mjs",
    "plugins/ferrum/index.ts", "plugins/ferrum/openclaw.plugin.json", "plugins/ferrum/package.json", "plugins/ferrum/src/policy.ts", "plugins/ferrum/src/host.ts",
    "config/ferrum.baseline.json5", "docker/sandbox/Dockerfile", "docs/STAGE1.md", "docs/STAGE2.md", "docs/THIRD_PARTY_LICENSES.md", "scripts/wsl/00-preflight.sh", "scripts/wsl/40-configure.sh", "scripts/windows/00-preflight.ps1"]) {
    assert.ok(files.includes(f), `${f} is not in the package`);
  }
});

test("shipped files: nothing private, no tests, no state", () => {
  const banned = [/^tests\//, /^node_modules\//, /^\.git/, /(^|\/)\.env/, /\.pem$/, /^secrets\//, /\.log$/, /^package-lock\.json$/, /\.bak\./];
  for (const f of files) for (const re of banned) assert.ok(!re.test(f), `${f} must not be published`);
  assert.ok(files.length < 80, `unexpectedly many files: ${files.length}`);
});

test("shipped text contains no secrets", () => {
  const patterns = [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/];
  for (const f of files) {
    const p = join(ROOT, f);
    if (!existsSync(p) || statSync(p).size > 1e6) continue;
    const text = readFileSync(p, "utf8");
    for (const re of patterns) assert.ok(!re.test(text), `${f} matches ${re}`);
  }
});

test("bin is executable text with a node shebang", () => {
  const t = readFileSync(join(ROOT, "bin", "ferrum.mjs"), "utf8");
  assert.ok(t.startsWith("#!/usr/bin/env node\n"));
  assert.ok(statSync(join(ROOT, "bin", "ferrum.mjs")).mode & 0o100, "bin must be executable in the repo");
});

test("every relative import in shipped JS/TS resolves to a shipped file", () => {
  for (const f of files.filter((x) => /\.(mjs|ts)$/.test(x))) {
    const text = readFileSync(join(ROOT, f), "utf8");
    for (const m of text.matchAll(/(?:from\s+|import\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = join(dirname(f), m[1]).replace(/\\/g, "/");
      assert.ok(files.includes(target), `${f} imports ${m[1]} which is not shipped (${target})`);
    }
  }
});

test("no CRLF line endings in shipped text files (a Windows checkout must not break scripts in WSL)", () => {
  for (const f of files.filter((x) => !/\.ps1$/.test(x))) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    assert.ok(!readFileSync(p, "utf8").includes("\r\n"), `${f} contains CRLF`);
  }
});

test(".gitattributes forces LF", () => {
  assert.match(readFileSync(join(ROOT, ".gitattributes"), "utf8"), /^\* text=auto eol=lf$/m);
});
