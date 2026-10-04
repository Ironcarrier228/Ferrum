import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveInRoot, toHostPath } from "../../plugins/ferrum/src/paths.ts";

const ROOT = "D:\\Ferrum";
const ok = (input: string) => { const r = resolveInRoot(input, ROOT); assert.ok(r.ok, `expected OK for ${JSON.stringify(input)}, got ${JSON.stringify(r)}`); return r; };
const bad = (input: unknown, why?: RegExp) => { const r = resolveInRoot(input, ROOT); assert.ok(!r.ok, `expected REFUSAL for ${JSON.stringify(input)}, got ${JSON.stringify(r)}`); if (why && !r.ok) assert.match(r.reason, why); };

test("accepted forms map to the same canonical path", () => {
  for (const p of ["notes\\a.txt", "notes/a.txt", "D:\\Ferrum\\notes\\a.txt", "d:/ferrum/notes/a.txt", "/mnt/d/Ferrum/notes/a.txt", "./notes/./a.txt", "notes/sub/../a.txt", "D:\\FERRUM\\Notes\\a.txt"]) {
    const r = ok(p);
    assert.equal(r.rel.toLowerCase(), "notes\\a.txt");
  }
  assert.equal(ok(".").rel, "");
  assert.equal(ok("D:\\Ferrum").rel, "");
});

test("traversal and other drives are refused", () => {
  bad("..\\x", /outside/);
  bad("a\\..\\..\\x", /outside/);
  bad("D:\\Ferrum\\..\\Windows", /outside/);
  bad("D:\\", /outside/);
  bad("D:\\Other\\a.txt", /outside/);
  bad("C:\\Windows\\system32", /drive/);
  bad("/mnt/c/Windows", /drive/);
  bad("/mnt/d/Other", /outside/);
  bad("D:\\Ferrum2\\a", /outside/); // prefix, not parent
  bad("D:\\FerrumX", /outside/);
  bad("../../../../../../../../etc/passwd", /escapes|outside/);
});

test("UNC, device paths, POSIX paths, rooted paths, drive-relative", () => {
  bad("\\\\server\\share\\a", /UNC/);
  bad("//server/share/a", /UNC/);
  bad("\\\\?\\C:\\Windows", /UNC/);
  bad("\\\\.\\PhysicalDrive0", /UNC/);
  bad("\\\\wsl$\\Ubuntu\\home", /UNC/);
  bad("\\\\wsl.localhost\\Ubuntu\\home\\user", /UNC/);
  bad("/etc/passwd", /POSIX/);
  bad("/home/user/.ssh/id_rsa", /POSIX/);
  bad("\\Windows\\System32", /rooted/);
  bad("D:Ferrum\\a", /drive-relative/);
  bad("D:a.txt", /drive-relative/);
});

test("Windows name tricks", () => {
  bad("a.txt::$DATA", /':'/);
  bad("a.txt:hidden", /':'/);
  bad("a:b", /drive-relative/);
  bad("file.txt.", /space or dot/);
  bad("file.txt ", /space or dot/);
  bad("dir \\a", /space or dot/);
  bad("PROGRA~1\\x", /8\.3/);
  bad("LONGNA~1.TXT", /8\.3/);
  for (const n of ["CON", "con", "NUL", "aux.txt", "COM1", "LPT9.log", "PRN", "COM\u00b9", "conin$"]) bad(n, /reserved/);
  for (const c of ["a<b", "a>b", "a|b", "a?b", "a*b", 'a"b', "a\u0001b"]) bad(c);
  ok("console.txt"); ok("nullable"); ok("com10.txt"); ok("aux2");
});

test("never expose virtual disks or system folders", () => {
  bad("ext4.vhdx", /virtual disk/);
  bad("wsl\\disk.VHDX", /virtual disk/);
  bad("vm.vhd", /virtual disk/);
  bad("$RECYCLE.BIN\\x", /protected/);
  bad("System Volume Information", /protected/);
});

test("bad input types and sizes", () => {
  bad(undefined); bad(null); bad(5); bad({}); bad([]); bad(""); bad("a".repeat(1001));
  bad("a\u0000b");
});

test("case and unicode folding", () => {
  assert.ok(resolveInRoot("d:\\FERRUM\\x", ROOT).ok);
  assert.ok(resolveInRoot("D:\\Ferrum\\\u00e9", ROOT).ok);
  assert.ok(!resolveInRoot("D:\\Ferrum\u202e\\x", ROOT).ok); // right-to-left override is not part of the root name
});

test("host path mapping", () => {
  assert.equal(toHostPath("a\\b.txt", "/mnt/d/Ferrum"), "/mnt/d/Ferrum/a/b.txt");
  assert.equal(toHostPath("", "/mnt/d/Ferrum/"), "/mnt/d/Ferrum");
});

test("other roots work too", () => {
  assert.ok(resolveInRoot("x", "E:\\Work\\Agent").ok);
  assert.ok(!resolveInRoot("D:\\Ferrum\\x", "E:\\Work\\Agent").ok);
  assert.ok(resolveInRoot("E:/work/agent/y", "E:\\Work\\Agent").ok);
  assert.ok(!resolveInRoot("E:/work/other", "E:\\Work\\Agent").ok);
});
