import { test } from "node:test";
import assert from "node:assert/strict";
import { decideLocal, sessionEligibleForLocal } from "../../plugins/ferrum/src/policy.ts";

const env = (existing: string[] = []) => ({ localRoot: "D:\\Ferrum", exists: (rel: string) => existing.includes(rel) });
const d = (tool: string, params: Record<string, unknown>, existing: string[] = []) => decideLocal(tool, params, env(existing));

test("reads and listings inside the root are allowed without approval", () => {
  assert.equal(d("local_read", { path: "a.txt" }).action, "allow");
  assert.equal(d("local_list", {}).action, "allow");
  assert.equal(d("local_list", { path: "sub" }).action, "allow");
});

test("reads outside the root are blocked", () => {
  for (const p of ["C:\\Users\\me\\.ssh\\id_rsa", "..\\..\\Windows", "\\\\srv\\x", "/etc/passwd", "ext4.vhdx"]) assert.equal(d("local_read", { path: p }).action, "block", p);
  assert.equal(d("local_read", {}).action, "block");
});

test("write: create is free, overwrite needs approval, root is protected", () => {
  assert.equal(d("local_write", { path: "new.txt", content: "x" }).action, "allow");
  const o = d("local_write", { path: "old.txt", content: "x" }, ["old.txt"]);
  assert.equal(o.action, "approve");
  assert.equal(d("local_write", { path: ".", content: "x" }).action, "block");
  assert.equal(d("local_write", { path: "x.txt", content: 5 }).action, "block");
  assert.equal(d("local_write", { path: "x.txt", content: "a".repeat(5 * 1024 * 1024 + 1) }).action, "block");
  assert.equal(d("local_write", { path: "..\\x.txt", content: "x" }).action, "block");
});

test("delete always needs approval; root cannot be deleted", () => {
  const r = d("local_delete", { path: "a.txt" });
  assert.equal(r.action, "approve");
  assert.equal(r.action === "approve" && r.severity, "critical");
  assert.equal(d("local_delete", { path: "." }).action, "block");
  assert.equal(d("local_delete", { path: "D:\\Ferrum" }).action, "block");
  assert.equal(d("local_delete", { path: "..\\x" }).action, "block");
});

test("exec: ordinary commands always need approval and show the whole command", () => {
  for (const c of ["Get-ChildItem", "git status", "dir", "python script.py", "git push origin main", "Get-Content notes\\a.txt", "Remove-Item old.txt"]) {
    const r = d("local_exec", { command: c });
    assert.equal(r.action, "approve", c);
    assert.ok(r.action === "approve" && r.description.includes(c));
  }
});

test("exec: hard refusals (obfuscation, escapes, system changes)", () => {
  const refused = [
    "powershell -enc SQBFAFgA", "pwsh -EncodedCommand AAA", "[Convert]::FromBase64String('AAAA')", "iex (gc x.ps1)", "Invoke-Expression $x",
    "Get-Content \\\\server\\share\\x", "ls \\\\wsl$\\Ubuntu\\home", "ls \\\\?\\C:\\", "wsl.exe -e cat /etc/passwd", "wsl cat ~/.openclaw/.env",
    "cd ..\\..", "Get-Content ..\\x", "ls ../..", "$env:USERPROFILE", "ls %USERPROFILE%", "cd ~", "ls $HOME", "[Environment]::GetFolderPath('Desktop')",
    "Format-Volume -DriveLetter D", "diskpart", "format C:", "bcdedit /set", "reg add HKLM\\Software\\x", "reg delete HKCU\\x /f", "Set-ExecutionPolicy Unrestricted",
    "New-Service -Name x", "schtasks /create /tn x", "sc.exe create x", "net user x /add", "Start-Process cmd -Verb RunAs", "Stop-Computer", "shutdown /s",
    "Get-Content C:\\Users\\me\\x.txt", "type C:\\Windows\\win.ini", "ls D:\\Other", "copy x E:\\y", "ls /mnt/c/Windows", "cat /mnt/d/Other/x",
    "Get-Content $HOME\\.ssh\\id_rsa", "gc .ssh/id_rsa", "ls .openclaw", "ls .aws",
  ];
  for (const c of refused) assert.equal(d("local_exec", { command: c }).action, "block", c);
});

test("exec: absolute paths inside the root are fine", () => {
  assert.equal(d("local_exec", { command: "Get-Content D:\\Ferrum\\a.txt" }).action, "approve");
  assert.equal(d("local_exec", { command: "ls /mnt/d/Ferrum/sub" }).action, "approve");
  assert.equal(d("local_exec", { command: 'type "D:/Ferrum/a b.txt"' }).action, "approve");
});

test("exec: the owner sees the WHOLE command, never a truncated one", () => {
  const cmd = "Get-ChildItem " + "x".repeat(370) + " ; END-MARKER";
  assert.ok(cmd.length <= 400);
  const r = d("local_exec", { command: cmd });
  assert.ok(r.action === "approve" && r.description.endsWith(cmd));
});

test("exec: too long, empty, control characters, wrong types", () => {
  assert.equal(d("local_exec", { command: "a".repeat(401) }).action, "block");
  assert.equal(d("local_exec", { command: "a".repeat(400) }).action, "approve");
  for (const c of ["", "   ", undefined, 5, null, {}, "ls\u0000x", "ls\u0007"]) assert.equal(d("local_exec", { command: c as any }).action, "block", String(c));
});

test("unknown local_* tool is blocked", () => {
  assert.equal(d("local_format_disk", {}).action, "block");
});

test("sessions that may never get local mode", () => {
  assert.ok(sessionEligibleForLocal("agent:main:telegram:direct:123").ok);
  assert.ok(sessionEligibleForLocal("agent:main:main").ok);
  for (const k of ["cron:job1", "agent:main:cron:job1", "agent:main:subagent:abc", "agent:main:spawn:x", "agent:main:acp:y", "agent:main:hook:z", "agent:main:heartbeat", "", undefined]) {
    assert.ok(!sessionEligibleForLocal(k as any).ok, String(k));
  }
});
