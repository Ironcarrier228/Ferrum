import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../../plugins/ferrum/index.ts";

type Hook = (event: any, ctx: any) => Promise<any> | any;
let tmp: string, mount: string, auditDir: string;
let tools: Array<{ factory: (ctx: any) => any; name: string }>, hooks: Record<string, Hook>, command: any;

const OWNER = { commands: { ownerAllowFrom: ["telegram:42"] } };
const KEY = "agent:main:telegram:direct:42";

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "ferrum-plugin-"));
  mount = join(tmp, "mnt"); auditDir = join(tmp, "audit"); mkdirSync(mount);
  tools = []; hooks = {};
  plugin.register({
    pluginConfig: { localRoot: "D:\\Ferrum", localRootMount: mount, auditDir, idleMinutes: 10, confirmSeconds: 60 },
    registerTool: (factory: any, opts: any) => tools.push({ factory, name: opts.name }),
    on: (name: string, h: Hook) => { hooks[name] = h; },
    registerCommand: (c: any) => { command = c; },
  } as any);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const cmd = (args: string, over: Record<string, unknown> = {}) =>
  command.handler({ sessionKey: KEY, channel: "telegram", senderId: "42", config: OWNER, args, ...over });
const visibleTools = (key = KEY) => tools.map((t) => t.factory({ sessionKey: key })).filter(Boolean).map((t: any) => t.name);
const enableLocal = async (key = KEY) => { const r = await cmd("local", { sessionKey: key }); const code = /confirm (\d{4})/.exec(r.text)![1]; return cmd(`confirm ${code}`, { sessionKey: key }); };
const before_ = (toolName: string, params: any, key = KEY) => hooks.before_tool_call({ toolName, params, runId: "r1", toolCallId: "c1" }, { sessionKey: key });

test("registration: 5 tools, hooks and command; command requires auth", () => {
  assert.deepEqual(tools.map((t) => t.name).sort(), ["local_delete", "local_exec", "local_list", "local_read", "local_write"]);
  assert.ok(hooks.before_tool_call && hooks.after_tool_call);
  assert.equal(command.name, "mode");
  assert.equal(command.requireAuth, true);
});

test("sandbox mode: no local_* tool is offered, calls are blocked", async () => {
  assert.deepEqual(visibleTools(), []);
  assert.deepEqual(tools.map((t) => t.factory({})).filter(Boolean), []); // no session key
  const r = await before_("local_read", { path: "a.txt" });
  assert.equal(r.block, true);
  assert.match(r.blockReason, /only available in local mode/);
  // other tools (sandboxed exec etc.) are not our business
  assert.equal(await before_("exec", { command: "ls" }), undefined);
});

test("/mode: non-owner is refused and nothing changes", async () => {
  for (const over of [{ senderId: "43" }, { channel: "discord" }, { config: {} }, { senderId: undefined }]) {
    const r = await cmd("local", over);
    assert.match(r.text, /только владельцу/);
  }
  assert.deepEqual(visibleTools(), []);
});

test("/mode: needs the code; wrong code does not enable", async () => {
  assert.match((await cmd("")).text, /SANDBOX/);
  const r = await cmd("local");
  assert.match(r.text, /\/mode confirm \d{4}/);
  assert.match((await cmd("confirm 0000")).text, /Не включено/);
  assert.deepEqual(visibleTools(), []);
  assert.match((await cmd("confirm")).text, /./); // bad syntax reply, no crash
});

test("/mode: ineligible sessions cannot enable local", async () => {
  for (const key of ["agent:main:cron:j1", "agent:main:subagent:x"]) {
    const r = await cmd("local", { sessionKey: key });
    assert.match(r.text, /недоступен/);
    assert.deepEqual(visibleTools(key), []);
  }
});

test("local mode: tools appear only for this session, policy applies", async () => {
  const r = await enableLocal();
  assert.match(r.text, /LOCAL/);
  assert.deepEqual(visibleTools().sort(), ["local_delete", "local_exec", "local_list", "local_read", "local_write"]);
  assert.deepEqual(visibleTools("agent:main:telegram:direct:99"), []);

  assert.equal(await before_("local_read", { path: "a.txt" }), undefined);             // allowed
  assert.equal((await before_("local_read", { path: "C:\\Windows\\win.ini" })).block, true);
  assert.equal((await before_("local_write", { path: "new.txt", content: "x" })), undefined);
  const del = await before_("local_delete", { path: "a.txt" });
  assert.deepEqual(del.requireApproval.allowedDecisions, ["allow-once", "deny"]);
  assert.equal(del.requireApproval.severity, "critical");
  const ex = await before_("local_exec", { command: "Get-Date" });
  assert.match(ex.requireApproval.description, /Get-Date/);
  assert.equal((await before_("local_exec", { command: "powershell -enc AAAA" })).block, true);
  ex.requireApproval.onResolution("deny");
});

test("execute re-checks the mode and the policy", async () => {
  const t: any = tools.find((x) => x.name === "local_write")!.factory({ sessionKey: KEY });
  const res = await t.execute("c", { path: "dir\\hello.txt", content: "hi" });
  assert.match(res.content[0].text, /wrote/);
  assert.equal(readFileSync(join(mount, "dir", "hello.txt"), "utf8"), "hi");
  await assert.rejects(t.execute("c", { path: "..\\x.txt", content: "no" }), /outside|escapes/i);
  assert.equal(existsSync(join(tmp, "x.txt")), false);
  const rd: any = tools.find((x) => x.name === "local_read")!.factory({ sessionKey: KEY });
  assert.equal((await rd.execute("c", { path: "dir/hello.txt" })).content[0].text, "hi");
  await assert.rejects(rd.execute("c", { path: "C:\\Windows\\win.ini" }));
  // back to sandbox: a tool object obtained earlier must refuse to run
  await cmd("sandbox");
  await assert.rejects(t.execute("c", { path: "late.txt", content: "x" }), /not active/);
  assert.equal(existsSync(join(mount, "late.txt")), false);
  assert.deepEqual(visibleTools(), []);
  assert.equal((await before_("local_read", { path: "a.txt" })).block, true);
});

test("approval-class tools refuse to run unless the hook sent that exact call to approval", async () => {
  await enableLocal();
  writeFileSync(join(mount, "victim.txt"), "v");
  const del: any = tools.find((x) => x.name === "local_delete")!.factory({ sessionKey: KEY });
  // no hook ran for this id
  await assert.rejects(del.execute("nohook", { path: "victim.txt" }), /needs owner approval/);
  assert.equal(existsSync(join(mount, "victim.txt")), true);
  // hook ran for params A; executing with params B is refused
  await hooks.before_tool_call({ toolName: "local_delete", params: { path: "other.txt" }, runId: "r", toolCallId: "mismatch" }, { sessionKey: KEY });
  await assert.rejects(del.execute("mismatch", { path: "victim.txt" }), /needs owner approval/);
  assert.equal(existsSync(join(mount, "victim.txt")), true);
  // denied approval: the later execute is refused
  const deny = await hooks.before_tool_call({ toolName: "local_delete", params: { path: "victim.txt" }, runId: "r", toolCallId: "denied" }, { sessionKey: KEY });
  deny.requireApproval.onResolution("deny");
  await assert.rejects(del.execute("denied", { path: "victim.txt" }), /needs owner approval/);
  // approved: runs once, and cannot be replayed
  await hooks.before_tool_call({ toolName: "local_delete", params: { path: "victim.txt" }, runId: "r", toolCallId: "ok1" }, { sessionKey: KEY });
  assert.match((await del.execute("ok1", { path: "victim.txt" })).content[0].text, /deleted/);
  assert.equal(existsSync(join(mount, "victim.txt")), false);
  writeFileSync(join(mount, "victim.txt"), "v");
  await assert.rejects(del.execute("ok1", { path: "victim.txt" }), /needs owner approval/);
  assert.equal(existsSync(join(mount, "victim.txt")), true);
  // overwrite goes through the same gate
  const wr: any = tools.find((x) => x.name === "local_write")!.factory({ sessionKey: KEY });
  await assert.rejects(wr.execute("w0", { path: "victim.txt", content: "X" }), /needs owner approval/);
  assert.equal(readFileSync(join(mount, "victim.txt"), "utf8"), "v");
  await cmd("sandbox");
});

test("audit log has decisions and no secrets", async () => {
  await before_("exec", { command: "echo", token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
  const f = join(auditDir, readdirSync(auditDir)[0]);
  const text = readFileSync(f, "utf8");
  const events = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.ev === "plugin_loaded"));
  assert.ok(events.some((e) => e.ev === "tool_call" && e.decision === "block"));
  assert.ok(events.some((e) => e.ev === "tool_call" && e.decision === "approval_requested"));
  assert.ok(events.some((e) => e.ev === "approval_resolved"));
  assert.ok(events.some((e) => e.ev === "mode_change"));
  assert.ok(events.some((e) => e.ev === "mode_command_refused"));
  assert.ok(!text.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
});

test("unlimited tool calls per turn by default; cap works when configured", async () => {
  for (let i = 0; i < 300; i++) assert.equal(await hooks.before_tool_call({ toolName: "exec", params: {}, runId: "big" }, { sessionKey: KEY }), undefined);
  const hk: Record<string, Hook> = {};
  plugin.register({ pluginConfig: { localRoot: "D:\\Ferrum", localRootMount: mount, auditDir: join(tmp, "a2"), maxToolCallsPerTurn: 3 }, registerTool() {}, on: (n: string, h: Hook) => { hk[n] = h; }, registerCommand() {} } as any);
  const outs = [];
  for (let i = 0; i < 5; i++) outs.push(await hk.before_tool_call({ toolName: "read", params: {}, runId: "cap" }, { sessionKey: KEY }));
  assert.deepEqual(outs.map((o) => !!o?.block), [false, false, false, true, true]);
  assert.equal(await hk.before_tool_call({ toolName: "read", params: {}, runId: "other" }, { sessionKey: KEY }), undefined);
});
void writeFileSync;
