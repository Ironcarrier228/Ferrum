// Contract tests: every claim about OpenClaw that Ferrum's design relies on is
// checked here against the *installed, pinned* package. When OpenClaw is
// upgraded and one of these fails, the design in docs/OPENCLAW_NOTES.md needs a
// review before anything else.
//
// No network, no Docker, no model keys required.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// package.json is not in OpenClaw's "exports", so locate it by path.
const ocDir = join(root, "node_modules", "openclaw");
const ocPkg = JSON.parse(readFileSync(join(ocDir, "package.json"), "utf8"));
const ferrumPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const ocBin = join(ocDir, "openclaw.mjs");

/** Run the pinned OpenClaw CLI against a throw-away HOME (never touches ~/.openclaw). */
function oc(args, home) {
  return execFileSync(process.execPath, [ocBin, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024, // `config schema` alone is ~2.4 MB
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tempHomeWithConfig(json5) {
  const home = mkdtempSync(join(tmpdir(), "ferrum-oc-"));
  mkdirSync(join(home, ".openclaw"), { recursive: true });
  const file = join(home, ".openclaw", "openclaw.json");
  writeFileSync(file, json5);
  chmodSync(file, 0o600);
  return home;
}

test("license: OpenClaw is MIT and the LICENSE file says so", () => {
  assert.equal(ocPkg.license, "MIT");
  const text = readFileSync(join(ocDir, "LICENSE"), "utf8");
  assert.match(text, /^MIT License/);
  assert.match(text, /Copyright \(c\) 2026 OpenClaw Foundation/);
});

test("pin: Ferrum depends on an exact OpenClaw version and it is the installed one", () => {
  const declared = ferrumPkg.dependencies.openclaw;
  assert.match(declared, /^\d{4}\.\d+\.\d+$/, "must be an exact version, no ^ or ~");
  assert.equal(ocPkg.version, declared);
});

test("runtime: current Node satisfies OpenClaw's engines range", () => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok = (major === 24 && minor >= 16) || (major === 26 && minor >= 1) || major > 26;
  assert.ok(ok, `Node ${process.versions.node} does not satisfy ${ocPkg.engines.node}`);
});

test("plugin SDK: subpaths Ferrum plugins will import are exported", () => {
  const exp = ocPkg.exports;
  for (const sub of ["./plugin-sdk/plugin-entry", "./plugin-sdk/tool-plugin"]) {
    assert.ok(exp[sub], `missing export ${sub}`);
  }
});

test("docs: hooks Ferrum relies on are documented in the shipped docs", () => {
  const ref = readFileSync(join(ocDir, "docs/plugins/hooks/reference.md"), "utf8");
  for (const hook of [
    "before_tool_call", // policy gate + requireApproval
    "after_tool_call", // audit result
    "before_prompt_build", // per-session system-prompt context + toolsAllow
    "message_received", // log of ignored/accepted inbound
    "session_end",
    "llm_output", // token accounting
  ]) {
    assert.ok(ref.includes("`" + hook + "`"), `hook ${hook} not in hooks reference`);
  }
  const tp = readFileSync(join(ocDir, "docs/plugins/hooks/tool-policy.md"), "utf8");
  for (const word of ["requireApproval", "block", "registerTrustedToolPolicy", "allowedDecisions"]) {
    assert.ok(tp.includes(word), `tool-policy.md lost "${word}"`);
  }
});

test("config schema: every key Ferrum's config will set exists", () => {
  const home = tempHomeWithConfig("{}");
  const schema = JSON.parse(oc(["config", "schema"], home));
  const deref = (n) => {
    while (n && n.$ref) {
      n = n.$ref.replace(/^#\//, "").split("/").reduce((a, k) => a[k], schema);
    }
    return n;
  };
  const child = (n, k) => {
    n = deref(n);
    if (!n) return undefined;
    if (n.properties?.[k]) return n.properties[k];
    for (const alt of [...(n.anyOf ?? []), ...(n.oneOf ?? []), ...(n.allOf ?? [])]) {
      const c = child(alt, k);
      if (c) return c;
    }
    if (n.additionalProperties && typeof n.additionalProperties === "object") return n.additionalProperties;
    return undefined;
  };
  const has = (path) => path.split(".").reduce((n, k) => (n ? child(n, k) : undefined), schema) !== undefined;

  const keys = [
    // sandbox
    "agents.defaults.sandbox.mode",
    "agents.defaults.sandbox.backend",
    "agents.defaults.sandbox.scope",
    "agents.defaults.sandbox.workspaceAccess",
    "agents.defaults.sandbox.docker.network",
    "agents.defaults.sandbox.docker.binds",
    "agents.defaults.sandbox.docker.readOnlyRoot",
    "agents.defaults.sandbox.docker.capDrop",
    "agents.defaults.sandbox.docker.memory",
    "agents.defaults.sandbox.docker.pidsLimit",
    "agents.defaults.timeoutSeconds",
    "agents.entries",
    // tool policy / host-escape switches
    "tools.profile",
    "tools.deny",
    "tools.fs.workspaceOnly",
    "tools.elevated.enabled",
    "tools.exec.host",
    "tools.exec.mode",
    "tools.exec.security",
    "tools.sandbox.tools.allow",
    "tools.sandbox.tools.alsoAllow",
    "tools.sandbox.tools.deny",
    "tools.loopDetection.enabled",
    "commands.bash",
    "commands.config",
    "commands.mcp",
    "commands.plugins",
    "commands.debug",
    "commands.restart",
    "commands.ownerAllowFrom",
    "acp.enabled",
    // gateway
    "gateway.mode",
    "gateway.bind",
    "gateway.port",
    "gateway.auth.mode",
    "gateway.auth.token",
    // channels / approvals
    "channels.telegram.botToken",
    "channels.telegram.dmPolicy",
    "channels.telegram.allowFrom",
    "channels.telegram.groupPolicy",
    "channels.telegram.execApprovals",
    "channels.telegram.capabilities.inlineButtons",
    "channels.whatsapp.dmPolicy",
    "channels.discord",
    "approvals.plugin",
    "approvals.exec",
    // plugins / skills / mcp / audit / install policy
    "plugins.allow",
    "plugins.deny",
    "plugins.load.paths",
    "plugins.entries",
    "skills.load.extraDirs",
    "mcp.servers",
    "logging.audit.enabled",
    "logging.level",
    "security.installPolicy",
    "session.dmScope",
  ];
  // negative controls: the checker must not be vacuously true
  for (const bogus of ["agents.defaults.sandbox.noSuchKey", "tools.elevated.noSuchKey", "gateway.noSuchKey"]) {
    assert.equal(has(bogus), false, `schema walker accepts bogus key ${bogus}`);
  }
  const missing = keys.filter((k) => !has(k));
  assert.deepEqual(missing, [], `config keys missing in OpenClaw ${ocPkg.version}`);
});

// The most important offline check of stage 0: with Ferrum's intended baseline,
// which tools can a sandboxed session see at all? Everything not listed here
// runs on the Gateway host, so it must not be reachable in sandbox mode.
const SANDBOX_CONTAINED = new Set([
  "exec", "process", "read", "ls", "write", "edit", "apply_patch", "view_image",
  "sessions_list", "sessions_history", "sessions_search", "sessions_send",
  "sessions_spawn", "sessions_yield", "subagents", "session_status",
]);
const HOST_SIDE = ["gateway", "nodes", "browser", "canvas", "computer", "automations", "mobile_ui"];

test("sandbox baseline: `sandbox explain` shows no host-side tool and no elevated path", () => {
  const home = tempHomeWithConfig(`{
    gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token: "${"a1".repeat(24)}" } },
    agents: { defaults: { sandbox: { mode: "all", scope: "session", workspaceAccess: "rw",
                                     docker: { network: "none" } } } },
    tools: { elevated: { enabled: false }, exec: { host: "sandbox" } },
    acp: { enabled: false },
    commands: { bash: false, config: false, mcp: false, plugins: false, debug: false, restart: false },
  }`);
  assert.match(oc(["config", "validate"], home), /Config valid/);

  const out = JSON.parse(oc(["sandbox", "explain", "--json"], home));
  assert.equal(out.sandbox.mode, "all");
  assert.equal(out.sandbox.sessionIsSandboxed, true);
  assert.equal(out.sandbox.backend, "docker");
  assert.equal(out.elevated.enabled, false);

  const allow = out.sandbox.tools.allow;
  const stray = allow.filter((t) => !SANDBOX_CONTAINED.has(t));
  assert.deepEqual(stray, [], "tools allowed in sandbox that are not known to run inside the container");
  for (const t of HOST_SIDE) {
    assert.ok(out.sandbox.tools.deny.includes(t), `${t} must be denied in sandbox`);
    assert.ok(!allow.includes(t), `${t} must not be allowed in sandbox`);
  }
});

test("sandbox backend: podman (no Docker Desktop) is a built-in, config-only choice with the same tool surface", () => {
  const home = tempHomeWithConfig(`{
    agents: { defaults: { sandbox: { mode: "all", backend: "podman", scope: "session", workspaceAccess: "rw",
                                     docker: { network: "none", readOnlyRoot: true, capDrop: ["ALL"] } } } },
    tools: { elevated: { enabled: false }, exec: { host: "sandbox" } },
  }`);
  assert.match(oc(["config", "validate"], home), /Config valid/);
  const out = JSON.parse(oc(["sandbox", "explain", "--json"], home));
  assert.equal(out.sandbox.backend, "podman");
  assert.equal(out.sandbox.sessionIsSandboxed, true);
  assert.deepEqual(out.sandbox.tools.allow.filter((t) => !SANDBOX_CONTAINED.has(t)), []);
});

test("sandbox baseline: only the agent workspace is mounted, nothing from the host else", () => {
  const home = tempHomeWithConfig(`{
    agents: { defaults: { sandbox: { mode: "all", scope: "session", workspaceAccess: "rw" } } },
  }`);
  const out = JSON.parse(oc(["sandbox", "explain", "--json"], home));
  const mounts = out.sandbox.workspaceMounts;
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].containerRoot, "/workspace");
  assert.ok(mounts[0].hostRoot.startsWith(home), "workspace must live under the (WSL) home, not /mnt/c");
});

test("default plugins: record what is enabled out-of-the-box (review on upgrade)", () => {
  const home = tempHomeWithConfig("{}");
  const j = JSON.parse(oc(["plugins", "list", "--json"], home));
  const enabled = (j.plugins ?? j).filter((p) => p.enabled).map((p) => p.id);
  // Host-capable plugins that are ON by default and therefore must be pinned
  // down with `plugins.allow` in Ferrum's real config (stage 1).
  for (const id of ["browser", "canvas", "file-transfer", "linux-node", "cua-computer", "device-pair"]) {
    assert.ok(enabled.includes(id), `expected default-enabled plugin ${id} (OpenClaw changed defaults?)`);
  }
  assert.ok(existsSync(join(ocDir, "docs")), "docs must ship with the package");
});
