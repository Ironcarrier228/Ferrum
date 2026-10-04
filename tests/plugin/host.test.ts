import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../../plugins/ferrum/src/config.ts";
import * as host from "../../plugins/ferrum/src/host.ts";

let tmp: string, mount: string, outside: string, cfg: ReturnType<typeof resolveConfig>, tkLog: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "ferrum-host-"));
  mount = join(tmp, "mnt-d-Ferrum"); outside = join(tmp, "outside");
  mkdirSync(mount); mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "SECRET");
  tkLog = join(tmp, "taskkill.log");
  // fake powershell.exe: prints a Windows-like PID line, then runs the part after "; " as a shell command
  writeFileSync(join(tmp, "powershell.exe"), `#!/bin/bash\ncmd="\${@: -1}"; rest="\${cmd#*; }"\necho "FERRUM_PID=4242"\neval "$rest"\n`, { mode: 0o755 });
  writeFileSync(join(tmp, "taskkill.exe"), `#!/bin/bash\necho "$@" >> "${tkLog}"\n`, { mode: 0o755 });
  cfg = resolveConfig({ localRoot: "D:\\Ferrum", localRootMount: mount, powershell: join(tmp, "powershell.exe"), taskkill: join(tmp, "taskkill.exe"), execTimeoutSeconds: 1 });
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test("write / read / list roundtrip inside the root", () => {
  assert.match(host.writeFile(cfg, "notes\\a.txt", "héllo"), /wrote 6 bytes/);
  assert.equal(host.readFile(cfg, "D:/Ferrum/notes/a.txt"), "héllo");
  assert.match(host.listDir(cfg, "notes"), /a\.txt/);
  assert.match(host.listDir(cfg, undefined), /notes\\/);
});

test("refuses everything outside the root", () => {
  for (const p of ["..\\outside\\secret.txt", "C:\\Windows\\win.ini", "\\\\srv\\x", "/etc/passwd", "ext4.vhdx"]) assert.throws(() => host.readFile(cfg, p), host.HostError, p);
  assert.throws(() => host.writeFile(cfg, "..\\evil.txt", "x"), host.HostError);
  assert.equal(existsSync(join(tmp, "evil.txt")), false);
  assert.throws(() => host.deletePath(cfg, "..\\outside\\secret.txt", false), host.HostError);
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "SECRET");
});

test("symlinks are not followed (file, directory and dangling ancestors)", () => {
  symlinkSync(join(outside, "secret.txt"), join(mount, "link.txt"));
  symlinkSync(outside, join(mount, "linkdir"));
  assert.throws(() => host.readFile(cfg, "link.txt"), /symbolic links/);
  assert.throws(() => host.readFile(cfg, "linkdir\\secret.txt"), /symbolic links/);
  assert.throws(() => host.writeFile(cfg, "linkdir\\new.txt", "x"), /symbolic links/);
  assert.equal(existsSync(join(outside, "new.txt")), false);
  assert.throws(() => host.deletePath(cfg, "linkdir", true), /symbolic links/);
  assert.equal(existsSync(join(outside, "secret.txt")), true);
  assert.throws(() => host.listDir(cfg, "linkdir"), /symbolic links/);
});

test("size limit on reads; folder delete needs recursive", () => {
  writeFileSync(join(mount, "big.txt"), "a".repeat(1024 * 1024 + 1));
  assert.throws(() => host.readFile(cfg, "big.txt"), /larger than 1 MB/);
  mkdirSync(join(mount, "d")); writeFileSync(join(mount, "d", "f"), "x");
  assert.throws(() => host.deletePath(cfg, "d", false), /recursive/);
  assert.match(host.deletePath(cfg, "d", true), /deleted/);
  assert.equal(existsSync(join(mount, "d")), false);
  assert.throws(() => host.deletePath(cfg, ".", true), host.HostError);
  assert.throws(() => host.writeFile(cfg, ".", "x"), host.HostError);
});

test("exec: output, exit code, PID line is stripped", async () => {
  const r = await host.execPowershell(cfg, "echo hello; echo err >&2; exit 3");
  assert.equal(r.code, 3);
  assert.equal(r.stdout.trim(), "hello");
  assert.equal(r.stderr.trim(), "err");
  assert.equal(r.timedOut, false);
  assert.match(host.joinOutput(r), /^\[exit 3\]\nhello\n\[stderr\]\nerr$/);
});

test("exec: runs in the root and gets a minimal environment", async () => {
  process.env.FERRUM_SECRET_PROBE = "leak";
  const r = await host.execPowershell(cfg, "pwd; echo \"[$FERRUM_SECRET_PROBE]\"");
  delete process.env.FERRUM_SECRET_PROBE;
  const lines = r.stdout.trim().split("\n");
  assert.ok(lines[0].endsWith("mnt-d-Ferrum"));
  assert.equal(lines[1], "[]");
});

test("exec: timeout kills the Windows process tree (taskkill /T /F) and reports it", async () => {
  const t0 = Date.now();
  const r = await host.execPowershell(cfg, "exec sleep 30");
  assert.ok(Date.now() - t0 < 8000);
  assert.equal(r.timedOut, true);
  assert.match(host.joinOutput(r), /TIMEOUT/);
  assert.match(readFileSync(tkLog, "utf8"), /\/PID 4242 \/T \/F/);
});

test("exec: abort signal kills it too", async () => {
  const ac = new AbortController();
  const p = host.execPowershell({ ...cfg, execTimeoutSeconds: 30 }, "exec sleep 30", ac.signal);
  setTimeout(() => ac.abort(), 300);
  const r = await p;
  assert.equal(r.timedOut, true);
});

test("exec: missing powershell reports an error instead of throwing", async () => {
  const r = await host.execPowershell({ ...cfg, powershell: join(tmp, "nope.exe") }, "echo x");
  assert.equal(r.code, null);
  assert.match(r.stderr, /spawn failed/);
});
void chmodSync;
