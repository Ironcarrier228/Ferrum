// The shipped baseline config (config/ferrum.baseline.json5) against the installed engine:
// it validates, the engine itself reports a sandboxed session with no host tool, and the static
// invariants hold. Negative controls prove each invariant can actually fail.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { assessConfig } from "../../src/check-config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASELINE = join(ROOT, "config", "ferrum.baseline.json5");
const OPENCLAW = join(ROOT, "node_modules", ".bin", "openclaw");
const baseline = () => JSON5.parse(readFileSync(BASELINE, "utf8"));

const ENV = {
  FERRUM_MODEL_ID: "test-model", FERRUM_MODEL_API_KEY: "dummy", FERRUM_TELEGRAM_USER_ID: "123456789",
  TELEGRAM_BOT_TOKEN: "123456:dummy", OPENCLAW_GATEWAY_TOKEN: "t".repeat(48),
  FERRUM_SANDBOX_UID: "1000", FERRUM_SANDBOX_GID: "1000", FERRUM_REPO: ROOT,
};

function inTempHome(configText, fn) {
  const home = mkdtempSync(join(tmpdir(), "ferrum-cfg-"));
  try {
    mkdirSync(join(home, ".openclaw"), { mode: 0o700 });
    writeFileSync(join(home, ".openclaw", "openclaw.json"), configText, { mode: 0o600 });
    const oc = (args) => execFileSync(OPENCLAW, args, { env: { PATH: process.env.PATH, HOME: home, ...ENV }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return fn(oc, home);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test("baseline: validates against the installed engine schema", () => {
  inTempHome(readFileSync(BASELINE, "utf8"), (oc) => assert.match(oc(["config", "validate"]), /Config valid/));
});

test("baseline: the engine reports a docker-sandboxed session, no elevated path, workspace-only mount", () => {
  inTempHome(readFileSync(BASELINE, "utf8"), (oc, home) => {
    const e = JSON.parse(oc(["sandbox", "explain", "--json"]));
    assert.equal(e.sandbox.mode, "all");
    assert.equal(e.sandbox.backend, "docker");
    assert.equal(e.sandbox.sessionIsSandboxed, true);
    assert.equal(e.elevated.enabled, false);
    assert.equal(e.sandbox.workspaceMounts.length, 1);
    assert.equal(e.sandbox.workspaceMounts[0].containerRoot, "/workspace");
    assert.equal(e.sandbox.workspaceMounts[0].hostRoot, join(home, "ferrum", "workspace"));
    for (const t of ["browser", "nodes", "gateway", "automations", "canvas"]) assert.ok(e.sandbox.tools.deny.includes(t), `${t} should be denied in the sandbox`);
  });
});

test("baseline: only telegram and our own ferrum plugin are allowed to load (plus memory-core, a slot plugin)", () => {
  inTempHome(readFileSync(BASELINE, "utf8"), (oc) => {
    const pl = JSON.parse(oc(["plugins", "list", "--json"]));
    const enabled = (pl.plugins ?? pl).filter((p) => p.enabled).map((p) => p.id).sort();
    assert.deepEqual(enabled, ["ferrum", "memory-core", "telegram"]);
  });
});

test("baseline: static invariants hold", () => {
  assert.deepEqual(assessConfig(baseline()), []);
});

test("negative controls: every dangerous edit is caught by the invariants", () => {
  const edits = {
    "sandbox.mode": (c) => { c.agents.defaults.sandbox.mode = "off"; },
    "sandbox.network": (c) => { c.agents.defaults.sandbox.docker.network = "bridge"; },
    "sandbox.noBinds": (c) => { c.agents.defaults.sandbox.docker.binds = ["/home:/home:rw"]; },
    "sandbox.noEnv": (c) => { c.agents.defaults.sandbox.docker.env = { K: "v" }; },
    "sandbox.readOnlyRoot": (c) => { c.agents.defaults.sandbox.docker.readOnlyRoot = false; },
    "sandbox.capDrop": (c) => { c.agents.defaults.sandbox.docker.capDrop = []; },
    "exec.host": (c) => { c.tools.exec.host = "gateway"; },
    "elevated": (c) => { c.tools.elevated.enabled = true; },
    "acp": (c) => { c.acp.enabled = true; },
    "gateway.bind": (c) => { c.gateway.bind = "lan"; },
    "gateway.tools": (c) => { c.gateway.tools = { allow: ["exec"] }; },
    "commands.bash": (c) => { c.commands.bash = true; },
    "telegram.dmPolicy": (c) => { c.channels.telegram.dmPolicy = "open"; },
    "telegram.allowFrom": (c) => { c.channels.telegram.allowFrom = ["*"]; },
    "telegram.configWrites": (c) => { delete c.channels.telegram.configWrites; },
    "plugins.allow": (c) => { delete c.plugins; },
    "plugins.noHostReaching": (c) => { c.plugins.allow.push("file-transfer"); },
    "timeout": (c) => { delete c.agents.defaults.timeoutSeconds; },
    "secret.channels.telegram.botToken": (c) => { c.channels.telegram.botToken = "123456:AAAbbbCCC"; },
    "secret.models.providers.custom.apiKey": (c) => { c.models.providers.custom.apiKey = "sk-live-abc"; },
    "workspace.notMnt": (c) => { c.agents.defaults.workspace = "/mnt/c/Users/me/ws"; },
  };
  for (const [id, edit] of Object.entries(edits)) {
    const c = baseline(); edit(c);
    const ids = assessConfig(c).map((x) => x.id);
    assert.ok(ids.includes(id), `edit for "${id}" was not caught (caught: ${ids.join(",") || "nothing"})`);
  }
});
