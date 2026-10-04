import { test } from "node:test";
import assert from "node:assert/strict";
import { ModeStore, parseModeArgs, isOwnerSender, type ModeEvent } from "../../plugins/ferrum/src/modes.ts";

function make() {
  let t = 1_000_000;
  const events: ModeEvent[] = [];
  const s = new ModeStore(10 * 60_000, 60_000, () => t, (e) => events.push(e));
  return { s, events, adv: (ms: number) => { t += ms; } };
}

test("default is sandbox, also for unknown sessions", () => {
  const { s } = make();
  assert.equal(s.mode("a"), "sandbox");
});

test("local needs request + the right code", () => {
  const { s } = make();
  assert.deepEqual(s.confirmLocal("a", "1234"), { ok: false, reason: "no pending request: send /mode local first" });
  const code = s.requestLocal("a");
  assert.match(code, /^\d{4}$/);
  assert.equal(s.mode("a"), "sandbox");
  const bad = s.confirmLocal("a", code === "1234" ? "4321" : "1234");
  assert.equal(bad.ok, false);
  assert.equal(s.mode("a"), "sandbox");
  // a wrong attempt burns the request: even the right code no longer works
  assert.equal(s.confirmLocal("a", code).ok, false);
  const code2 = s.requestLocal("a");
  assert.equal(s.confirmLocal("a", code2).ok, true);
  assert.equal(s.mode("a"), "local");
});

test("the confirmation code expires", () => {
  const { s, adv } = make();
  const code = s.requestLocal("a");
  adv(61_000);
  assert.equal(s.confirmLocal("a", code).ok, false);
  assert.equal(s.mode("a"), "sandbox");
});

test("the code of one session does not work in another", () => {
  const { s } = make();
  const code = s.requestLocal("a");
  assert.equal(s.confirmLocal("b", code).ok, false);
  assert.equal(s.mode("b"), "sandbox");
  assert.equal(s.mode("a"), "sandbox");
});

test("local falls back to sandbox after 10 idle minutes; activity keeps it alive", () => {
  const { s, adv, events } = make();
  s.confirmLocal("a", (s.requestLocal("a")));
  assert.equal(s.mode("a"), "local");
  adv(9 * 60_000); s.touch("a");
  adv(9 * 60_000); assert.equal(s.mode("a"), "local");
  adv(10 * 60_000 + 1);
  assert.equal(s.mode("a"), "sandbox");
  assert.ok(events.some((e) => e.ev === "mode_expired"));
  // expiry is sticky: touching afterwards does not resurrect it
  s.touch("a");
  assert.equal(s.mode("a"), "sandbox");
});

test("setSandbox is immediate and idempotent", () => {
  const { s } = make();
  s.confirmLocal("a", s.requestLocal("a"));
  assert.equal(s.setSandbox("a"), true);
  assert.equal(s.mode("a"), "sandbox");
  assert.equal(s.setSandbox("a"), false);
});

test("modes are per session", () => {
  const { s } = make();
  s.confirmLocal("a", s.requestLocal("a"));
  assert.equal(s.mode("a"), "local");
  assert.equal(s.mode("b"), "sandbox");
});

test("audit events for mode changes", () => {
  const { s, events } = make();
  s.requestLocal("a"); s.confirmLocal("a", "0000");
  s.confirmLocal("a", s.requestLocal("a"));
  s.setSandbox("a");
  const kinds = events.map((e) => e.ev);
  assert.ok(kinds.includes("mode_confirm_requested") && kinds.includes("mode_confirm_failed") && kinds.filter((k) => k === "mode_change").length === 2);
});

test("argument parsing", () => {
  assert.deepEqual(parseModeArgs(""), { kind: "status" });
  assert.deepEqual(parseModeArgs(undefined), { kind: "status" });
  assert.deepEqual(parseModeArgs(" LOCAL "), { kind: "local" });
  assert.deepEqual(parseModeArgs("sandbox"), { kind: "sandbox" });
  assert.deepEqual(parseModeArgs("confirm 0042"), { kind: "confirm", code: "0042" });
  for (const a of ["confirm", "confirm 12", "confirm abcd", "local now", "root", "confirm 1234 5"]) assert.equal(parseModeArgs(a).kind, "bad", a);
});

test("owner check uses channel:senderId from commands.ownerAllowFrom", () => {
  const cfg = { commands: { ownerAllowFrom: ["telegram:42"] } };
  assert.ok(isOwnerSender(cfg, "telegram", "42"));
  assert.ok(!isOwnerSender(cfg, "telegram", "43"));
  assert.ok(!isOwnerSender(cfg, "discord", "42"));
  assert.ok(!isOwnerSender(cfg, undefined, "42"));
  assert.ok(!isOwnerSender(cfg, "telegram", undefined));
  assert.ok(!isOwnerSender({}, "telegram", "42"));
  assert.ok(!isOwnerSender({ commands: { ownerAllowFrom: ["*"] } }, "telegram", "42"));
});
