// Stage 1 isolation test: commands issued through the REAL agent loop run inside the
// container and cannot see the host.
//
//   node tests/isolation/run.mjs            real test (needs a working `docker`); exit 0 = isolated
//   node tests/isolation/run.mjs --control  needs no docker. (0) docker missing -> the turn fails closed.
//                                           (a) sandbox OFF but exec.host=sandbox:
//                                           exec must be refused. (b) negative control: sandbox OFF and
//                                           exec.host=gateway, the same probes must DETECT the leaks
//                                           (proves the probes are able to fail).
//
// Exit codes: 0 ok, 1 test failed, 77 skipped (no docker; never reported as a pass).
//
// How it works (no real model, no Telegram, no network):
//   1. Renders config/ferrum.baseline.json5 into a throwaway HOME inside your real home, with a
//      fixed, printed list of test-only overrides (ports, fake model URL, Telegram off).
//   2. Plants canaries on the host: a file, a fake ~/.ssh key, a fake .env, env vars that look like
//      the gateway's secrets (model API key, bot token, gateway token).
//   3. A fake OpenAI-compatible server answers the gateway's first request with a scripted `exec`
//      tool call (the probe script) and records the tool result the gateway sends back.
//   4. `openclaw agent --message ...` runs a real agent turn; the probe output is parsed.
//   5. Host side: `docker inspect` of the sandbox container (mounts, caps, network, ...).
import { spawn, spawnSync, execFileSync, execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, readlinkSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import http from "node:http";
import JSON5 from "json5";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OPENCLAW = join(ROOT, "node_modules", ".bin", "openclaw");
const CONTROL = process.argv.includes("--control");
const KEEP = process.argv.includes("--keep");
// Slow machines (cold disk, antivirus, small WSL VM) need more time: FERRUM_TEST_TIMEOUT_X=6 multiplies all waits.
const X = Number(process.env.FERRUM_TEST_TIMEOUT_X ?? 3);
const GW_PORT = 18890 + Math.floor(Math.random() * 50);
const MODEL_PORT = GW_PORT + 100;

const results = []; // {name, ok, detail}
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`  [${ok ? " OK " : "FAIL"}] ${name}${detail ? "  (" + detail + ")" : ""}`);
};
const rid = () => randomBytes(6).toString("hex");

function dockerAvailable() {
  const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
  return r.status === 0;
}

// ---------------------------------------------------------------- scenario plumbing
function renderConfig({ T, sandboxOff, execHost, prefix, secrets }) {
  const cfg = JSON5.parse(readFileSync(join(ROOT, "config", "ferrum.baseline.json5"), "utf8"));
  const overrides = [];
  const set = (path, value) => {
    const keys = path.split(".");
    let o = cfg;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys.at(-1)] = value;
    overrides.push(`${path} = ${JSON.stringify(value)}`);
  };
  set("gateway.port", GW_PORT);
  set("gateway.auth.token", secrets.gatewayToken);
  set("models.providers.custom.baseUrl", `http://127.0.0.1:${MODEL_PORT}/v1`);
  set("models.providers.custom.apiKey", secrets.apiKey);
  set("models.providers.custom.models", [{ id: "fake-model", name: "fake-model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }]);
  set("agents.defaults.model", "custom/fake-model");
  set("channels.telegram.enabled", false);
  set("channels.telegram.botToken", secrets.botToken);
  set("commands.ownerAllowFrom", ["telegram:1"]);
  set("channels.telegram.allowFrom", ["1"]);
  set("plugins.allow", ["telegram"]);
  if (!sandboxOff) set("agents.defaults.sandbox.docker.containerPrefix", prefix);
  if (sandboxOff) set("agents.defaults.sandbox.mode", "off");
  if (execHost) set("tools.exec.host", execHost);
  return { cfg, overrides };
}

function buildProbe({ T, gwPort }) {
  const canaryDir = join(T, "host-secret");
  const realHome = homedir();
  return [
    `echo "IN_DOCKERENV=$([ -e /.dockerenv ] && echo 1 || echo 0)"`,
    `echo "UID=$(id -u)"`,
    `echo "HOSTNAME=$(cat /etc/hostname 2>/dev/null || hostname)"`,
    `echo "HOME_LS=$(ls /home 2>/dev/null | tr '\\n' ',')"`,
    `echo "MNT_C=$([ -e /mnt/c ] && echo 1 || echo 0)"`,
    `echo "CANARY_FILE=$([ -e '${canaryDir}/ferrum-canary-file.txt' ] && echo 1 || echo 0)"`,
    `echo "CANARY_SSH=$([ -e '${T}/.ssh/ferrum-canary-key' ] && echo 1 || echo 0)"`,
    `echo "CANARY_ENVFILE=$([ -e '${T}/.openclaw/.env' ] && echo 1 || echo 0)"`,
    `echo "OC_CONFIG=$([ -e '${T}/.openclaw/openclaw.json' ] && echo 1 || echo 0)"`,
    `echo "REAL_HOME=$([ -e '${realHome}/.ssh' ] || [ -e '${realHome}/.openclaw' ] && echo 1 || echo 0)"`,
    `echo "FIND_CANARY=$(timeout 25 find / -xdev -name 'ferrum-canary-*' -not -path '/proc/*' -not -path '/workspace/*' 2>/dev/null | wc -l)"`,
    `echo "ENV_CANARY=$(env | grep -ci 'canary')"`,
    `echo "DOCKER_SOCK=$([ -e /var/run/docker.sock ] || [ -e /run/docker.sock ] && echo 1 || echo 0)"`,
    `echo "ROOT_WRITE=$(touch /etc/ferrum-probe 2>/dev/null && echo 1 || echo 0)"`,
    `echo "WS_MARKER=$([ -e /workspace/ferrum-workspace-marker.txt ] && echo 1 || echo 0)"`,
    `echo "WS_WRITE=$(touch /workspace/ferrum-probe-written 2>/dev/null && echo 1 || echo 0)"`,
    `echo "CAPEFF=$(grep CapEff /proc/self/status | awk '{print $2}')"`,
    `echo "NONEWPRIVS=$(grep NoNewPrivs /proc/self/status | awk '{print $2}')"`,
    `echo "NETDEV=$(ls /sys/class/net 2>/dev/null | tr '\\n' ',')"`,
    `echo "NET_INTERNET=$(curl -s -m 3 -o /dev/null -w '%{http_code}' https://example.com 2>/dev/null; true)"`,
    `echo "NET_GATEWAY=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${gwPort}/ 2>/dev/null; true)"`,
    `echo "NET_MODEL=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${MODEL_PORT}/v1/models 2>/dev/null; true)"`,
    `echo "PROBE_DONE=1"`,
  ].join("\n");
}

function parseProbe(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function startFakeModel(probeCmd, logFile) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed; try { parsed = JSON.parse(body); } catch { parsed = null; }
        try { writeFileSync(logFile, JSON.stringify({ url: req.url, body: parsed }) + "\n", { flag: "a" }); }
        catch { console.log(`  [INFO] late request ${req.method} ${req.url} arrived after its scenario ended (ignored)`); res.statusCode = 503; return res.end(); }
        if (req.url.endsWith("/models")) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "fake-model" }] })); }
        const toolMsgs = (parsed?.messages ?? []).filter((m) => m.role === "tool");
        const hasTool = toolMsgs.length > 0;
        const lastText = hasTool ? (typeof toolMsgs.at(-1).content === "string" ? toolMsgs.at(-1).content : JSON.stringify(toolMsgs.at(-1).content)) : "";
        // On a slow machine exec may auto-background ("Command still running (session X ...)"): poll it.
        const allTools = toolMsgs.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
        const sid = allTools.map((t) => /session ([\w-]+)/.exec(t)?.[1]).find(Boolean);
        const running = hasTool && sid && !allTools.some((t) => /PROBE_DONE/.test(t)) && /still running|status.{0,6}running/i.test(lastText) ? [null, sid] : null;
        const mkCall = (name, args) => ({ role: "assistant", tool_calls: [{ index: 0, id: "call_" + toolMsgs.length, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
        const delta = running && toolMsgs.length < 40
          ? mkCall("process", { action: "poll", sessionId: running[1], timeout: 30000 })
          : hasTool
            ? { role: "assistant", content: "probe finished" }
            : mkCall("exec", { command: probeCmd, yieldMs: 120000 });
        const finish = delta.tool_calls ? "tool_calls" : "stop";
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        if (parsed?.stream) {
          res.setHeader("content-type", "text/event-stream");
          const ch = (d, f) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
          res.write(ch(delta, null)); res.write(ch({}, finish));
          res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [], usage })}\n\n`);
          return res.end("data: [DONE]\n\n");
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "c", object: "chat.completion", created: 0, model: "fake-model", choices: [{ index: 0, message: delta, finish_reason: finish }], usage }));
      });
    });
    srv.listen(MODEL_PORT, "127.0.0.1", () => resolve(srv));
  });
}

function runAsync(cmd, args, env, timeoutMs) {
  // Must be async: the fake model server lives in this process and has to keep answering.
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => c.kill("SIGKILL"), timeoutMs);
    c.on("close", (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
  });
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 400)); }
  throw new Error(`timeout waiting for ${what}`);
}

// Listening addresses for `port`, restricted to sockets owned by processes of our gateway's
// process group (some sandboxes/hosts run port forwarders that show up as extra listeners).
function listeningAddrs(port, pgid) {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const pids = execFileSync("ps", ["-eo", "pid=,pgid="], { encoding: "utf8" }).trim().split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number)).filter(([, g]) => g === pgid).map(([p]) => p);
  const inodes = new Set();
  for (const pid of pids) {
    try { for (const fd of readdirSync(`/proc/${pid}/fd`)) { try { const l = readlinkSync(`/proc/${pid}/fd/${fd}`); const m = l.match(/^socket:\[(\d+)\]$/); if (m) inodes.add(m[1]); } catch {} } } catch {}
  }
  const addrs = [];
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n").slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length > 9 && c[3] === "0A" && c[1].endsWith(":" + hex) && inodes.has(c[9])) addrs.push(c[1].split(":")[0]);
    }
  }
  return addrs;
}

async function scenario({ label, sandboxOff, execHost, breakDocker, expectExecRefused, control }) {
  console.log(`\n== ${label}`);
  const realHome = homedir();
  const T = mkdtempSync(join(realHome, ".ferrum-iso-"));
  const prefix = `ferrum-iso-${rid()}-`;
  const secrets = {
    gatewayToken: `ferrum-canary-gwtoken-${rid()}${rid()}${rid()}`,
    apiKey: `ferrum-canary-apikey-${rid()}`,
    botToken: `123456:ferrum-canary-bot-${rid()}`,
  };
  const procs = [];
  let watching = false;
  let model;
  try {
    // host layout + canaries
    mkdirSync(join(T, ".openclaw"), { recursive: true, mode: 0o700 });
    mkdirSync(join(T, ".ssh"), { recursive: true });
    mkdirSync(join(T, "host-secret"), { recursive: true });
    mkdirSync(join(T, "ferrum", "workspace"), { recursive: true });
    writeFileSync(join(T, "host-secret", "ferrum-canary-file.txt"), "CANARY-FILE-CONTENT\n");
    writeFileSync(join(T, ".ssh", "ferrum-canary-key"), "-----BEGIN FAKE KEY-----\n");
    writeFileSync(join(T, ".openclaw", ".env"), `FERRUM_MODEL_API_KEY=${secrets.apiKey}\n`, { mode: 0o600 });
    writeFileSync(join(T, "ferrum", "workspace", "ferrum-workspace-marker.txt"), "workspace marker\n");
    const { cfg, overrides } = renderConfig({ T, sandboxOff, execHost, prefix, secrets });
    writeFileSync(join(T, ".openclaw", "openclaw.json"), JSON.stringify(cfg, null, 2), { mode: 0o600 });
    console.log("  test-only overrides of config/ferrum.baseline.json5:");
    for (const o of overrides) console.log("    - " + o.replace(/ferrum-canary-[a-z]+-?[0-9a-f]*/g, "<canary>").slice(0, 120));

    const modelLog = join(T, "model-requests.jsonl");
    const probe = buildProbe({ T, gwPort: GW_PORT });
    model = await startFakeModel(probe, modelLog);

    // "docker unusable": a shim that always fails comes FIRST in PATH, and DOCKER_HOST points at a dead
    // socket. (Merely removing docker's directory from PATH is not enough: the gateway still finds it.)
    let PATH = process.env.PATH;
    if (breakDocker) {
      mkdirSync(join(T, "shim"));
      writeFileSync(join(T, "shim", "docker"), "#!/bin/sh\necho 'docker: simulated failure (Ferrum isolation test)' >&2\nexit 1\n", { mode: 0o755 });
      PATH = join(T, "shim") + delimiter + PATH;
    }
    const env = {
      PATH, HOME: T, LANG: "C.UTF-8",
      FERRUM_MODEL_API_KEY: secrets.apiKey, TELEGRAM_BOT_TOKEN: secrets.botToken,
      OPENCLAW_GATEWAY_TOKEN: secrets.gatewayToken, FERRUM_CANARY_ENV: "canary-env-value",
      FERRUM_SANDBOX_UID: String(process.getuid()), FERRUM_SANDBOX_GID: String(process.getgid()),
      ...(breakDocker ? { DOCKER_HOST: "unix:///nonexistent/ferrum-no-docker.sock" } : process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    };
    const gw = spawn(OPENCLAW, ["gateway", "run", "--port", String(GW_PORT)], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    procs.push(gw);
    let gwLog = "";
    gw.stdout.on("data", (d) => (gwLog += d)); gw.stderr.on("data", (d) => (gwLog += d));
    try {
      await waitFor(() => /\[gateway\] ready/.test(gwLog), 90000 * X, "gateway ready");
    } catch (e) {
      console.log("  gateway log (tail) at ready-timeout:\n" + gwLog.split("\n").slice(-25).join("\n"));
      throw e;
    }

    // ---- gateway-level checks (config, not sandbox)
    const addrs = listeningAddrs(GW_PORT, gw.pid);
    check("gateway listens on loopback only", addrs.length > 0 && addrs.every((a) => a === "0100007F" || a === "00000000000000000000000001000000"), addrs.join(","));
    const post = (auth) => new Promise((resolve) => {
      const rq = http.request({ host: "127.0.0.1", port: GW_PORT, path: "/tools/invoke", method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) } }, (r) => { r.resume(); resolve(r.statusCode); });
      rq.on("error", () => resolve(0)); rq.end(JSON.stringify({ tool: "sessions_list", args: {} }));
    });
    check("API without token is rejected (401)", (await post(null)) === 401);
    check("API with a wrong token is rejected (401)", (await post("Bearer wrong")) === 401);

    // ---- one real agent turn
    // OpenClaw may remove the sandbox container once the turn ends, so inspect it WHILE the turn runs:
    // a watcher records the first `docker inspect` of every sandbox container whose bind mount points into this scenario.
    const seen = new Map();
    const dockerAsync = (args) => new Promise((resolve, reject) => execFile("docker", args, { encoding: "utf8", timeout: 20000 }, (e, out) => (e ? reject(e) : resolve(out))));
    if (!sandboxOff) {
      watching = true;
      (async () => {
        while (watching) {
          try {
            const ids = (await dockerAsync(["ps", "-a", "-q", "--no-trunc", "--filter", "label=openclaw.sandbox=1"])).split("\n").filter(Boolean);
            for (const id of ids) {
              if (seen.has(id)) continue;
              const c = JSON.parse(await dockerAsync(["inspect", id]))[0];
              if ((c.Mounts ?? []).some((m) => m.Source?.startsWith(T))) seen.set(id, c);
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 600));
        }
      })();
    }
    const agent = await runAsync(OPENCLAW, ["agent", "--message", "run the probe", "--session-key", "agent:main:isolation", "--json", "--timeout", String(120 * X)], env, 180000 * X);
    watching = false;
    const reqs = existsSync(modelLog) ? readFileSync(modelLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

    if (breakDocker) {
      const modelHit = reqs.some((r) => r.url.endsWith("/chat/completions"));
      const failedTurn = agent.status !== 0 || /"ok":\s*false/.test(agent.stdout);
      check("docker unusable -> the turn fails (fail-closed) ...", failedTurn, (agent.stdout.match(/Sandbox mode requires[^"|]*|sandbox_provisioning[^"|]*/) ?? [""])[0].slice(0, 90));
      check("... and the model was never contacted, nothing ran on the host", !modelHit);
      if (!failedTurn || modelHit) {
        console.log("  --- diagnostics ---");
        console.log("  agent exit:", agent.status, "| model requests:", reqs.length);
        console.log("  agent stdout (head):", agent.stdout.slice(0, 900));
        console.log("  agent stderr (head):", agent.stderr.slice(0, 400));
        console.log("  gateway log (tail):\n" + gwLog.split("\n").slice(-15).join("\n"));
      }
      return;
    }

    const toolTexts = (reqs.at(-1)?.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    const toolText = toolTexts.findLast((t) => /PROBE_DONE/.test(t)) ?? toolTexts.at(-1) ?? "";
    if (expectExecRefused) {
      check("sandbox off + exec.host=sandbox: exec is refused, not run on the host", /requires a sandbox runtime/.test(toolText) && !/PROBE_DONE/.test(toolText), toolText.replace(/\s+/g, " ").slice(0, 110));
      return;
    }
    const p = parseProbe(toolText.replace(/\\n/g, "\n"));
    if (!p.PROBE_DONE) {
      console.log("  agent stdout:", agent.stdout.slice(0, 600), "\n  agent stderr:", agent.stderr.slice(0, 600), "\n  tool message:", toolText.slice(0, 600));
      check("probe ran and returned output", false);
      return;
    }
    check("probe ran and returned output", true);

    const lines = [];
    const inv = (name, ok, detail) => lines.push({ name, ok, detail });
    // invariants: ok = true means "isolated as required"
    inv("runs inside a container (/.dockerenv)", p.IN_DOCKERENV === "1", `IN_DOCKERENV=${p.IN_DOCKERENV}`);
    inv("container hostname differs from the host's", p.HOSTNAME !== hostname(), p.HOSTNAME);
    inv("non-root user inside", p.UID && p.UID !== "0", `uid=${p.UID}`);
    inv("/home has no host users", !p.HOME_LS || p.HOME_LS === "sandbox,", p.HOME_LS);
    inv("no /mnt/c", p.MNT_C === "0");
    inv("host canary file not visible by absolute path", p.CANARY_FILE === "0");
    inv("fake ~/.ssh key not visible", p.CANARY_SSH === "0");
    inv("fake .env not visible", p.CANARY_ENVFILE === "0");
    inv("OpenClaw config not visible", p.OC_CONFIG === "0");
    inv("real $HOME/.ssh and $HOME/.openclaw not visible", p.REAL_HOME === "0");
    inv("filesystem search finds no canary files", p.FIND_CANARY === "0", `found=${p.FIND_CANARY}`);
    inv("gateway secrets/env not inherited (no 'canary' in env)", p.ENV_CANARY === "0", `matches=${p.ENV_CANARY}`);
    inv("no docker.sock inside", p.DOCKER_SOCK === "0");
    inv("root filesystem is read-only", p.ROOT_WRITE === "0");
    inv("all capabilities dropped (CapEff=0)", /^0+$/.test(p.CAPEFF ?? "x"), p.CAPEFF);
    inv("no-new-privileges set", p.NONEWPRIVS === "1");
    inv("only loopback network device", (p.NETDEV ?? "").replace(/,$/, "") === "lo", p.NETDEV);
    inv("no internet", p.NET_INTERNET === "000", `http=${p.NET_INTERNET}`);
    inv("cannot reach the gateway on host loopback", p.NET_GATEWAY === "000", `http=${p.NET_GATEWAY}`);
    inv("cannot reach the model endpoint on host loopback", p.NET_MODEL === "000", `http=${p.NET_MODEL}`);
    // positive controls: the container really works on OUR workspace
    inv("(positive) workspace marker visible at /workspace", p.WS_MARKER === "1");
    inv("(positive) /workspace is writable", p.WS_WRITE === "1");
    inv("(positive) write inside the container shows up in the host workspace", existsSync(join(T, "ferrum", "workspace", "ferrum-probe-written")));

    if (control) {
      // Negative control: with sandbox OFF the probes MUST flag the leaks.
      const mustFail = ["runs inside a container (/.dockerenv)", "host canary file not visible by absolute path", "fake ~/.ssh key not visible", "fake .env not visible", "OpenClaw config not visible", "filesystem search finds no canary files"];
      for (const name of mustFail) {
        const r = lines.find((l) => l.name === name);
        check(`control: probe detects leak -> "${name}"`, r && !r.ok, r ? `detail=${r.detail ?? ""}` : "");
      }
      const envLeak = lines.find((l) => l.name.startsWith("gateway secrets/env"));
      console.log(`  [INFO] host exec env canary matches: ${envLeak?.detail} (informational; OpenClaw may filter host exec env)`);
      return;
    }
    for (const l of lines) check(l.name, l.ok, l.detail);

    // ---- host-side inspection of the container OpenClaw created
    const ids = [...seen.keys()];
    check("exactly one sandbox container was created for the session (observed during the turn)", ids.length === 1, `n=${ids.length}`);
    if (ids.length !== 1) {
      console.log("  --- diagnostics: docker ps -a ---\n" + spawnSync("docker", ["ps", "-a", "--format", "{{.ID}} {{.Names}} {{.Status}} {{.Label \"openclaw.sessionKey\"}}"], { encoding: "utf8" }).stdout);
    } else {
      const still = spawnSync("docker", ["ps", "-a", "-q", "--filter", `id=${ids[0]}`], { encoding: "utf8" }).stdout.trim();
      console.log(`  [INFO] container ${still ? "still exists" : "was removed"} after the turn ended`);
    }
    if (ids.length >= 1) {
      const c = seen.get(ids[0]);
      const mounts = c.Mounts.filter((m) => m.Type === "bind");
      const wsDir = join(T, "ferrum", "workspace").replace(/\/$/, "");
      const wsMount = mounts.filter((m) => m.Destination === "/workspace");
      // OpenClaw also projects its read-only skills dir into the workspace (nested bind); anything else is a failure.
      const extra = mounts.filter((m) => m.Destination !== "/workspace");
      const extraOk = extra.every((m) => m.RW === false && m.Destination === "/workspace/.openclaw/sandbox-skills/skills" && m.Source.startsWith(wsDir + "/.openclaw/sandbox-skills"));
      const desc = mounts.map((m) => `${m.Source.replace(T, "<T>")}->${m.Destination}${m.RW ? "" : " (ro)"}`).join(" ; ");
      check("bind mounts: the agent workspace (rw) + at most the read-only sandbox-skills projection", wsMount.length === 1 && wsMount[0].RW === true && wsMount[0].Source.replace(/\/$/, "") === wsDir && extraOk, desc);
      if (extra.length) console.log("  [INFO] extra bind mounts (expected, read-only): " + desc);
      const foreign = spawnSync("find", [join(T, "ferrum", "workspace"), "!", "-uid", String(process.getuid()), "-printf", "%u %p\\n"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
      const unexpected = foreign.filter((l) => !l.split(" ").slice(1).join(" ").includes("/.openclaw/sandbox-skills"));
      check("files not owned by the host user in the workspace are only Docker's read-only mount points", unexpected.length === 0, unexpected.slice(0, 3).join(" | ") || `${foreign.length} mount-point dir(s)`);
      check("no docker.sock in any mount", !JSON.stringify(c.Mounts).includes("docker.sock") && !(c.HostConfig.Binds ?? []).join().includes("docker.sock"));
      check("not privileged", c.HostConfig.Privileged === false);
      check("network mode none", c.HostConfig.NetworkMode === "none", c.HostConfig.NetworkMode);
      check("read-only root filesystem", c.HostConfig.ReadonlyRootfs === true);
      check("CapDrop includes ALL", (c.HostConfig.CapDrop ?? []).map((x) => x.toUpperCase()).includes("ALL"), JSON.stringify(c.HostConfig.CapDrop));
      check("CapAdd empty", (c.HostConfig.CapAdd ?? []).length === 0);
      check("no-new-privileges", (c.HostConfig.SecurityOpt ?? []).some((s) => s.includes("no-new-privileges")), JSON.stringify(c.HostConfig.SecurityOpt));
      check("not host PID/IPC/network/userns namespace", c.HostConfig.PidMode !== "host" && c.HostConfig.IpcMode !== "host" && c.HostConfig.NetworkMode !== "host" && c.HostConfig.UsernsMode !== "host");
      check("no devices passed", (c.HostConfig.Devices ?? []).length === 0);
      check("memory and pids limits set", c.HostConfig.Memory > 0 && c.HostConfig.PidsLimit > 0, `mem=${c.HostConfig.Memory} pids=${c.HostConfig.PidsLimit}`);
      const envBlob = (c.Config.Env ?? []).join("\n");
      check("no canary secret in container env (docker inspect)", !/canary/i.test(envBlob));
      check("image is the Ferrum sandbox image", c.Config.Image === "ferrum-sandbox:bookworm-slim", c.Config.Image);
    }
  } finally {
    watching = false;
    for (const pr of procs) { try { process.kill(-pr.pid, "SIGKILL"); } catch {} }
    if (model) { model.close(); model.closeAllConnections?.(); }
    killStragglers(T);
    if (!sandboxOff) {
      try {
        const ids = execFileSync("docker", ["ps", "-a", "-q", "--filter", `name=${prefix}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
        for (const id of ids) spawnSync("docker", ["rm", "-f", id]);
      } catch {}
    }
    if (!KEEP) removeTree(T);
    else console.log(`  kept ${T}`);
  }
}

// Processes that outlived the gateway's process group but still carry this scenario's HOME.
function killStragglers(T) {
  try {
    for (const pid of readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
      if (Number(pid) === process.pid) continue;
      let env = ""; try { env = readFileSync(`/proc/${pid}/environ`, "utf8"); } catch { continue; }
      if (!env.split("\0").includes(`HOME=${T}`)) continue;
      let cmd = ""; try { cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").slice(0, 100); } catch {}
      console.log(`  [INFO] straggler process outlived the scenario, killing: pid ${pid} ${cmd}`);
      try { process.kill(Number(pid), "SIGKILL"); } catch {}
    }
  } catch {}
}

// Cleanup must never abort the test. Files created from inside containers may be owned by someone else
// or be read-only: report them (a root-owned file would itself be a finding), then force-remove.
function removeTree(T) {
  try { rmSync(T, { recursive: true, force: true }); return; } catch {}
  try {
    const odd = spawnSync("find", [T, "!", "-uid", String(process.getuid()), "-printf", "%u:%g %p\n"], { encoding: "utf8" }).stdout.trim();
    if (odd) console.log(`  [INFO] files not owned by uid ${process.getuid()} (created from inside a container?):\n    ` + odd.split("\n").slice(0, 8).join("\n    "));
  } catch {}
  spawnSync("chmod", ["-R", "u+rwX", T]);
  try { rmSync(T, { recursive: true, force: true }); return; } catch {}
  if (!CONTROL) {
    const r = spawnSync("docker", ["run", "--rm", "--user", "0", "--network", "none", "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "-v", `${dirname(T)}:/p`, "ferrum-sandbox:bookworm-slim", "rm", "-rf", `/p/${T.split("/").pop()}`], { encoding: "utf8" });
    if (r.status === 0 && !existsSync(T)) return;
  }
  console.log(`  [WARN] could not remove ${T}; delete it with: sudo rm -rf ${T}`);
}

// ---------------------------------------------------------------- main
console.log(`Ferrum isolation test (${CONTROL ? "NEGATIVE CONTROL: sandbox OFF, expecting detected leaks" : "REAL: sandbox ON"})`);
if (!CONTROL && !dockerAvailable()) {
  console.log("SKIPPED: no working `docker` (run scripts/wsl/20-install-docker.sh, then re-run). This is NOT a pass.");
  process.exit(77);
}
async function run(opts) {
  try { await scenario(opts); }
  catch (e) { check(`scenario "${opts.label}" completed without harness error`, false, String(e?.message ?? e)); }
}
if (CONTROL) {
  await run({ label: "fail-closed: docker unusable (failing shim first in PATH + dead DOCKER_HOST)", breakDocker: true });
  await run({ label: "layer 2: sandbox off but exec.host=sandbox (as in config)", sandboxOff: true, expectExecRefused: true });
  await run({ label: "control: sandbox off AND exec.host=gateway (deliberately broken)", sandboxOff: true, execHost: "gateway", control: true });
} else {
  await run({ label: "fail-closed: docker unusable (failing shim first in PATH + dead DOCKER_HOST)", breakDocker: true });
  await run({ label: "layer 2: sandbox off but exec.host=sandbox (as in config)", sandboxOff: true, expectExecRefused: true });
  await run({ label: "sandbox on: probes through a real agent turn" });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
