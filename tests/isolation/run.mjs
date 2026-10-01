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
import { spawn, spawnSync, execFileSync } from "node:child_process";
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
        writeFileSync(logFile, JSON.stringify({ url: req.url, body: parsed }) + "\n", { flag: "a" });
        if (req.url.endsWith("/models")) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "fake-model" }] })); }
        const hasTool = parsed?.messages?.some((m) => m.role === "tool");
        const delta = hasTool
          ? { role: "assistant", content: "probe finished" }
          : { role: "assistant", tool_calls: [{ index: 0, id: "call_probe", type: "function", function: { name: "exec", arguments: JSON.stringify({ command: probeCmd }) } }] };
        const finish = hasTool ? "stop" : "tool_calls";
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

async function scenario({ label, sandboxOff, execHost, stripDockerFromPath, expectExecRefused, control }) {
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

    let PATH = process.env.PATH;
    if (stripDockerFromPath) {
      PATH = PATH.split(delimiter).filter((d) => !existsSync(join(d, "docker"))).join(delimiter);
    }
    const env = {
      PATH, HOME: T, LANG: "C.UTF-8",
      FERRUM_MODEL_API_KEY: secrets.apiKey, TELEGRAM_BOT_TOKEN: secrets.botToken,
      OPENCLAW_GATEWAY_TOKEN: secrets.gatewayToken, FERRUM_CANARY_ENV: "canary-env-value",
      FERRUM_SANDBOX_UID: String(process.getuid()), FERRUM_SANDBOX_GID: String(process.getgid()),
      ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    };
    const gw = spawn(OPENCLAW, ["gateway", "run", "--port", String(GW_PORT)], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    procs.push(gw);
    let gwLog = "";
    gw.stdout.on("data", (d) => (gwLog += d)); gw.stderr.on("data", (d) => (gwLog += d));
    await waitFor(() => /\[gateway\] ready/.test(gwLog), 90000 * X, "gateway ready");

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
    const agent = await runAsync(OPENCLAW, ["agent", "--message", "run the probe", "--session-key", "agent:main:isolation", "--json", "--timeout", String(120 * X)], env, 180000 * X);
    const reqs = existsSync(modelLog) ? readFileSync(modelLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

    if (stripDockerFromPath) {
      const modelHit = reqs.some((r) => r.url.endsWith("/chat/completions"));
      check("without docker the turn fails (fail-closed) ...", agent.status !== 0 || /"ok":\s*false/.test(agent.stdout), (agent.stdout.match(/Sandbox mode requires[^"|]*/) ?? [""])[0].slice(0, 90));
      check("... and the model was never contacted, nothing ran on the host", !modelHit);
      return;
    }

    const toolMsg = reqs.flatMap((r) => r.body?.messages ?? []).filter((m) => m.role === "tool").at(-1);
    const toolText = toolMsg ? (typeof toolMsg.content === "string" ? toolMsg.content : JSON.stringify(toolMsg.content)) : "";
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
    const ids = execFileSync("docker", ["ps", "-a", "--filter", `name=${prefix}`, "--format", "{{.ID}}"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    check("exactly one sandbox container was created for the session", ids.length === 1, `n=${ids.length}`);
    if (ids.length >= 1) {
      const c = JSON.parse(execFileSync("docker", ["inspect", ids[0]], { encoding: "utf8" }))[0];
      const mounts = c.Mounts.filter((m) => m.Type === "bind");
      check("only bind mount is the agent workspace -> /workspace", mounts.length === 1 && mounts[0].Destination === "/workspace" && mounts[0].Source.replace(/\/$/, "").endsWith(join(T, "ferrum", "workspace").replace(/\/$/, "")), mounts.map((m) => `${m.Source}->${m.Destination}`).join(" ; "));
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
    for (const pr of procs) { try { process.kill(-pr.pid, "SIGKILL"); } catch {} }
    if (model) model.close();
    if (!sandboxOff) {
      try {
        const ids = execFileSync("docker", ["ps", "-a", "-q", "--filter", `name=${prefix}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
        for (const id of ids) spawnSync("docker", ["rm", "-f", id]);
      } catch {}
    }
    if (!KEEP) rmSync(T, { recursive: true, force: true });
    else console.log(`  kept ${T}`);
  }
}

// ---------------------------------------------------------------- main
console.log(`Ferrum isolation test (${CONTROL ? "NEGATIVE CONTROL: sandbox OFF, expecting detected leaks" : "REAL: sandbox ON"})`);
if (!CONTROL && !dockerAvailable()) {
  console.log("SKIPPED: no working `docker` (run scripts/wsl/20-install-docker.sh, then re-run). This is NOT a pass.");
  process.exit(77);
}
try {
  if (CONTROL) {
    await scenario({ label: "fail-closed: docker missing from the gateway's PATH", stripDockerFromPath: true });
    await scenario({ label: "layer 2: sandbox off but exec.host=sandbox (as in config)", sandboxOff: true, expectExecRefused: true });
    await scenario({ label: "control: sandbox off AND exec.host=gateway (deliberately broken)", sandboxOff: true, execHost: "gateway", control: true });
  } else {
    await scenario({ label: "fail-closed: docker missing from the gateway's PATH", stripDockerFromPath: true });
    await scenario({ label: "layer 2: sandbox off but exec.host=sandbox (as in config)", sandboxOff: true, expectExecRefused: true });
    await scenario({ label: "sandbox on: probes through a real agent turn" });
  }
} catch (e) {
  check("scenario completed without harness error", false, String(e?.message ?? e));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
