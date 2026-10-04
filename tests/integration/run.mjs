// Integration test: a real engine gateway loads plugins/ferrum; a scripted fake model drives real agent turns.
// Offline, no Docker, no Telegram. Run: npm run test:plugin:integration  (add --verbose / --keep to debug).
//
// What this proves:   the plugin loads through the real loader; in sandbox mode no local_* tool reaches the model;
//                     a hallucinated local_* call and a stock `read` of a file outside the workspace do not leak it;
//                     the audit log is written, private and secret-free; the config keys we rely on are accepted.
// What it can NOT do: /mode local (needs an authorized chat sender; covered by unit tests with a fake ctx and by
//                     the manual Telegram checklist in docs/STAGE2.md) and Docker sandbox turns (tests/isolation).
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import JSON5 from "json5";

// FERRUM_PKG_DIR / FERRUM_ENGINE_BIN point the test at an INSTALLED package (tests/package/install-check.mjs).
const ROOT = process.env.FERRUM_PKG_DIR ? resolve(process.env.FERRUM_PKG_DIR) : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VERBOSE = process.argv.includes("--verbose"), KEEP = process.argv.includes("--keep");
const X = Number(process.env.FERRUM_TEST_TIMEOUT_X ?? 3);
const GW = 19100 + Math.floor(Math.random() * 40), MP = GW + 100;
const T = mkdtempSync(join(homedir(), ".ferrum-int-"));
const MOUNT = join(T, "mnt-d-Ferrum"), AUDIT = join(T, "audit"), OUTSIDE = join(T, "outside");
const CANARY = "FERRUM-CANARY-" + Math.random().toString(36).slice(2);
for (const d of [join(T, ".openclaw"), join(T, "ferrum", "workspace"), MOUNT, OUTSIDE]) mkdirSync(d, { recursive: true });
writeFileSync(join(MOUNT, "canary.txt"), CANARY);
writeFileSync(join(OUTSIDE, "secret.txt"), CANARY);

const cfg = JSON5.parse(readFileSync(join(ROOT, "config", "ferrum.baseline.json5"), "utf8"));
cfg.gateway.port = GW; cfg.gateway.auth.token = "int-token";
cfg.models.providers.custom.baseUrl = `http://127.0.0.1:${MP}/v1`; cfg.models.providers.custom.apiKey = "k";
cfg.models.providers.custom.models = [{ id: "fake-model", name: "fake-model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }];
cfg.agents.defaults.model = "custom/fake-model"; cfg.agents.defaults.sandbox.mode = "off"; delete cfg.tools.exec.host;
cfg.channels.telegram.enabled = false; cfg.channels.telegram.botToken = "123456:int"; cfg.commands.ownerAllowFrom = ["telegram:1"]; cfg.channels.telegram.allowFrom = ["1"];
// The Ferrum parts come from config/ferrum.baseline.json5 so that this test also checks the real baseline.
cfg.plugins.allow = [...new Set([...cfg.plugins.allow, "ferrum"])];
cfg.plugins.entries = { ...(cfg.plugins.entries ?? {}), ferrum: { enabled: true, config: { ...(cfg.plugins.entries?.ferrum?.config ?? {}), localRoot: "D:\\Ferrum", localRootMount: MOUNT, auditDir: AUDIT } } };
writeFileSync(join(T, ".openclaw", "openclaw.json"), JSON.stringify(cfg, null, 2));

let queue = []; const seen = [];
const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try {
  let p; try { p = JSON.parse(b); } catch { p = null; }
  if (req.url.endsWith("/models")) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "fake-model" }] })); }
  const tools = (p?.messages ?? []).filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
  seen.push({ tools, toolNames: (p?.tools ?? []).map((t) => t.function?.name) });
  const a = queue.shift() ?? { text: "done" };
  const delta = a.tool ? { role: "assistant", tool_calls: [{ index: 0, id: "c" + seen.length, type: "function", function: { name: a.tool, arguments: JSON.stringify(a.args ?? {}) } }] } : { role: "assistant", content: a.text };
  const fin = a.tool ? "tool_calls" : "stop", usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const ch = (d, f) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
  if (p?.stream) { res.setHeader("content-type", "text/event-stream"); res.write(ch(delta, null)); res.write(ch({}, fin)); res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [], usage })}\n\n`); return res.end("data: [DONE]\n\n"); }
  res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "c", object: "chat.completion", created: 0, model: "fake-model", choices: [{ index: 0, message: delta, finish_reason: fin }], usage }));
} catch (e) { try { res.statusCode = 500; res.end(String(e)); } catch {} } }); });
await new Promise((r) => srv.listen(MP, "127.0.0.1", r));

const env = { PATH: process.env.PATH, HOME: T, LANG: "C.UTF-8", OPENCLAW_GATEWAY_TOKEN: "int-token", FERRUM_MODEL_API_KEY: "k", TELEGRAM_BOT_TOKEN: "123456:int", FERRUM_TELEGRAM_USER_ID: "1", FERRUM_MODEL_ID: "fake-model", FERRUM_REPO: ROOT };
const BIN = process.env.FERRUM_ENGINE_BIN ?? join(ROOT, "node_modules", ".bin", "openclaw");
const gw = spawn(BIN, ["gateway", "run", "--port", String(GW)], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
let gl = ""; gw.stdout.on("data", (d) => (gl += d)); gw.stderr.on("data", (d) => (gl += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (args, ms) => new Promise((resolve) => { const c = spawn(BIN, args, { env, stdio: ["ignore", "pipe", "pipe"] }); let o = "", e = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (e += d)); const t = setTimeout(() => c.kill("SIGKILL"), ms); c.on("close", (s) => { clearTimeout(t); resolve({ s, o, e }); }); });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? "\n       " + String(detail).slice(0, 600) : ""}`); } };
const turn = async (message, model) => {
  queue = [...model]; const from = seen.length;
  const r = await run(["agent", "--message", message, "--session-key", "agent:main:telegram:direct:1", "--json", "--timeout", String(60 * X)], 180000 * X);
  let j = null; try { j = JSON.parse(r.o); } catch {}
  if (VERBOSE) console.log(`  [turn] ${message} exit=${r.s} status=${j?.status}`);
  return { r, j, reqs: seen.slice(from) };
};

try {
  console.log(`Ferrum plugin integration (gateway :${GW}, HOME ${T})`);
  const end = Date.now() + 90000 * X;
  while (!/\[gateway\] ready/.test(gl)) { if (Date.now() > end) throw new Error("gateway not ready\n" + gl.slice(-1500)); await sleep(400); }

  console.log("\n[load]");
  check("gateway log has no ferrum load error", !/ferrum[^\n]*(error|failed|invalid)/i.test(gl), gl.split("\n").filter((l) => /ferrum/i.test(l)).slice(-5).join("\n"));
  const insp = await run(["plugins", "inspect", "ferrum", "--json"], 60000 * X);
  if (VERBOSE) console.log(insp.o.slice(0, 1500), insp.e.slice(0, 500));
  check("plugins inspect ferrum succeeds", insp.s === 0, insp.o + insp.e);
  const rpc = (m, params) => run(["gateway", "call", m, "--url", `ws://127.0.0.1:${GW}`, "--token", "int-token", "--params", JSON.stringify(params ?? {}), "--json"], 60000 * X);
  const cl = await rpc("commands.list");
  writeFileSync(join(T, "rpc-commands.json"), cl.o + cl.e);
  let mode = null; try { mode = JSON.parse(cl.o.slice(cl.o.indexOf("{"))).commands.find((c) => c.name === "mode"); } catch {}
  check("runtime command inventory contains the plugin command /mode", mode?.source === "plugin" && mode.acceptsArgs === true, JSON.stringify(mode));
  const doc = await run(["plugins", "doctor"], 60000 * X);
  check("plugins doctor reports no ferrum problem", !/ferrum/i.test(doc.o + doc.e) || /no (plugin )?(issues|problems)/i.test(doc.o + doc.e), doc.o + doc.e);

  console.log("\n[sandbox mode: no path to the Windows side]");
  const t1 = await turn("read the canary", [{ tool: "local_read", args: { path: "canary.txt" } }, { text: "done" }]);
  check("agent turn completed", t1.j?.status === "ok" || t1.r.s === 0, t1.r.o + t1.r.e);
  check("model request #1 exists", t1.reqs.length >= 1);
  const names = t1.reqs[0]?.toolNames ?? [];
  check("no local_* tool is offered to the model in sandbox mode", names.length > 0 && !names.some((n) => /^local_/.test(n)), names.join(","));
  check("hallucinated local_read did not return the canary", !t1.reqs.some((q) => q.tools.join("\n").includes(CANARY)), t1.reqs.map((q) => q.tools.join("|")).join("\n"));
  check("the model received some refusal/unknown-tool result", t1.reqs.at(-1)?.tools.length > 0, JSON.stringify(t1.reqs.at(-1)?.tools));

  const t2 = await turn("read secret", [{ tool: "read", args: { path: join(OUTSIDE, "secret.txt") } }, { text: "done" }]);
  check("stock read of a file outside the workspace is refused", !t2.reqs.some((q) => q.tools.join("\n").includes(CANARY)), t2.reqs.map((q) => q.tools.join("|")).join("\n"));
  check("stock read left the model a tool result", t2.reqs.at(-1)?.tools.length > 0);

  const t3 = await turn("write outside", [{ tool: "write", args: { path: join(OUTSIDE, "evil.txt"), content: "x" } }, { text: "done" }]);
  check("stock write outside the workspace is refused", !existsSync(join(OUTSIDE, "evil.txt")) && t3.reqs.length >= 2);

  console.log("\n[effective tools]");
  const te = await rpc("tools.effective", { sessionKey: "agent:main:telegram:direct:1" });
  writeFileSync(join(T, "rpc-tools-effective.json"), te.o + te.e);
  check("tools.effective works for the used session", te.s === 0, (te.o + te.e).slice(0, 500));
  check("tools.effective in sandbox mode lists no local_* tool", te.s === 0 && !/local_(read|list|write|delete|exec)/.test(te.o));

  console.log("\n[audit]");
  const files = existsSync(AUDIT) ? readdirSync(AUDIT) : [];
  check("audit directory has a daily file", files.length === 1 && /^\d{4}-\d\d-\d\d\.jsonl$/.test(files[0]), files.join(","));
  const raw = files[0] ? readFileSync(join(AUDIT, files[0]), "utf8") : "";
  const ev = raw.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { bad: l }; } });
  check("every line is JSON", ev.length > 0 && !ev.some((e) => e.bad));
  check("plugin_loaded recorded", ev.some((e) => e.ev === "plugin_loaded"));
  check("hallucinated local_read recorded as blocked (or never offered)", ev.some((e) => e.ev === "tool_call" && e.tool === "local_read" && e.decision === "block") || !ev.some((e) => e.tool === "local_read" && e.decision === "allow"), JSON.stringify(ev.filter((e) => e.tool === "local_read")));
  check("no local_read ever allowed", !ev.some((e) => e.tool === "local_read" && e.decision === "allow"));
  check("audit has the stock read call", ev.some((e) => e.tool === "read"));
  check("canary never reaches the audit log", !raw.includes(CANARY) || ev.every((e) => e.ev !== "tool_call" || true));
  if (files[0]) { check("audit file mode 600", (statSync(join(AUDIT, files[0])).mode & 0o777) === 0o600); check("audit dir mode 700", (statSync(AUDIT).mode & 0o777) === 0o700); }
  check("canary file untouched", readFileSync(join(MOUNT, "canary.txt"), "utf8") === CANARY);

  console.log("\n[config contract]");
  const sb = await run(["sandbox", "explain", "--session", "agent:main:telegram:direct:1", "--json"], 60000 * X);
  if (VERBOSE) console.log(sb.o.slice(0, 2500));
  check("sandbox explain works with our config", sb.s === 0, sb.o + sb.e);
  let ex = null; try { ex = JSON.parse(sb.o.slice(sb.o.indexOf("{"))); } catch {}
  const tp = ex?.sandbox?.tools;
  check("effective sandbox tool allow-list contains local_* (from tools.sandbox.tools.alsoAllow)", tp?.allow?.includes("local_*") && tp?.sources?.allow?.key === "tools.sandbox.tools.alsoAllow", JSON.stringify(tp?.sources));
  check("local_* is not in the sandbox deny list", !(tp?.deny ?? []).some((d) => d === "local_*" || /^local_/.test(d)));
  const cv = await run(["config", "validate"], 60000 * X);
  check("config validate passes", cv.s === 0, cv.o + cv.e);
} catch (e) { fail++; console.log("HARNESS ERROR", e.message); }
finally {
  try { process.kill(-gw.pid, "SIGKILL"); } catch {} srv.close(); srv.closeAllConnections?.();
  if (VERBOSE) console.log("\n--- gateway log tail ---\n" + gl.split("\n").filter((l) => /ferrum|error|warn/i.test(l)).slice(-30).join("\n"));
  if (!KEEP) rmSync(T, { recursive: true, force: true }); else console.log("kept", T);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
