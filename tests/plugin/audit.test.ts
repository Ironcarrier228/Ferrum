import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Audit, redact, sanitize } from "../../plugins/ferrum/src/audit.ts";

test("secrets are redacted", () => {
  const samples: Array<[string, string]> = [
    ["token 123456789:AAH7sKkq8d2lPzXx0Jr9wQeRtYuIoPaSdFgHj here", "AAH7sKkq8d2lPzXx0Jr9wQeRtYuIoPaSdFgHj"],
    ["key sk-abcdefghijklmnopqrstuvwx", "sk-abcdefghijklmnopqrstuvwx"],
    ["Authorization: Bearer abcdefghijklmnop1234", "abcdefghijklmnop1234"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
    ["password=hunter22secret", "hunter22secret"],
    ['{"api_key": "verysecretvalue1"}', "verysecretvalue1"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----", "abc"],
  ];
  for (const [input, secret] of samples) assert.ok(!redact(input).includes(secret), input);
  assert.equal(redact("plain text, nothing to hide"), "plain text, nothing to hide");
});

test("sanitize: nested keys, truncation, depth", () => {
  const out = sanitize({ token: "x".repeat(10), nested: { apiKey: "k", list: ["Bearer abcdefghijklmnop1234"] }, big: "a".repeat(5000) }) as any;
  assert.equal(out.token, "<redacted>");
  assert.equal(out.nested.apiKey, "<redacted>");
  assert.ok(!JSON.stringify(out).includes("abcdefghijklmnop1234"));
  assert.ok(out.big.length < 2100 && out.big.includes("[+3000 chars]"));
});

test("audit file: JSONL, daily file, private permissions, never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "ferrum-audit-"));
  try {
    const a = new Audit(join(dir, "sub"), () => new Date("2026-10-04T10:00:00Z"));
    a.write({ ev: "x", params: { token: "supersecretvalue" }, note: "Bearer abcdefghijklmnop1234" });
    a.write({ ev: "y" });
    const files = readdirSync(join(dir, "sub"));
    assert.deepEqual(files, ["2026-10-04.jsonl"]);
    const lines = readFileSync(join(dir, "sub", files[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].ts, "2026-10-04T10:00:00.000Z");
    assert.ok(!JSON.stringify(lines[0]).includes("supersecretvalue") && !JSON.stringify(lines[0]).includes("abcdefghijklmnop1234"));
    assert.equal(statSync(join(dir, "sub")).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "sub", files[0])).mode & 0o777, 0o600);
    // unwritable location: must not throw
    writeFileSync(join(dir, "afile"), "x");
    const bad = new Audit(join(dir, "afile", "sub"));
    assert.doesNotThrow(() => bad.write({ ev: "z" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
