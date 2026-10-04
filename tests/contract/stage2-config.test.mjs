// Stage 2 invariants of the shipped baseline + the ferrum plugin manifest.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cfg = JSON5.parse(readFileSync(join(ROOT, "config", "ferrum.baseline.json5"), "utf8"));
const manifest = JSON.parse(readFileSync(join(ROOT, "plugins", "ferrum", "openclaw.plugin.json"), "utf8"));
const LOCAL = ["local_delete", "local_exec", "local_list", "local_read", "local_write"];

test("the sandbox tool policy opens exactly local_* and nothing broader", () => {
  assert.deepEqual(cfg.tools.sandbox.tools.alsoAllow, ["local_*"]);
  assert.equal(cfg.tools.sandbox.tools.allow, undefined);
  assert.equal(cfg.tools.sandbox.tools.deny, undefined, "do not shrink OpenClaw's default sandbox deny list");
});

test("stock host routes stay closed", () => {
  assert.equal(cfg.tools.exec.host, "sandbox");
  assert.equal(cfg.tools.elevated.enabled, false);
  assert.equal(cfg.tools.fs.workspaceOnly, true);
  assert.equal(cfg.agents.defaults.sandbox.mode, "all");
  assert.equal(cfg.acp.enabled, false);
  assert.equal(cfg.commands.bash, false);
});

test("local_* tools are called directly (Tool Search would hide plugin tools); loop detection on", () => {
  assert.equal(cfg.tools.toolSearch, false);
  assert.equal(cfg.tools.loopDetection.enabled, true);
});

test("ferrum plugin is allowlisted, loaded from the repo, with no call cap by default", () => {
  assert.ok(cfg.plugins.allow.includes("ferrum"));
  assert.deepEqual(cfg.plugins.load.paths, ["${FERRUM_REPO}/plugins/ferrum"]);
  assert.equal(cfg.plugins.entries.ferrum.enabled, true);
  const c = cfg.plugins.entries.ferrum.config;
  assert.equal(c.localRoot, "D:\\Ferrum");
  assert.ok(!("maxToolCallsPerTurn" in c) || c.maxToolCallsPerTurn === null);
  for (const k of Object.keys(c)) assert.ok(k in manifest.configSchema.properties, `config key ${k} is not in the plugin schema`);
});

test("approval prompts go to the owner's DM; only the owner is a command owner", () => {
  const t = cfg.channels.telegram;
  assert.deepEqual(t.execApprovals.approvers, ["${FERRUM_TELEGRAM_USER_ID}"]);
  assert.equal(t.execApprovals.target, "dm");
  assert.deepEqual(cfg.commands.ownerAllowFrom, ["telegram:${FERRUM_TELEGRAM_USER_ID}"]);
  assert.equal(t.dmPolicy, "allowlist");
  assert.equal(t.groupPolicy, "disabled");
});

test("manifest declares exactly the five local_* tools and a strict config schema", () => {
  assert.deepEqual([...manifest.contracts.tools].sort(), LOCAL);
  assert.equal(manifest.id, "ferrum");
  assert.equal(manifest.configSchema.additionalProperties, false);
});
