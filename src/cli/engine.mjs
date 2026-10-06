import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Locate the agent engine this package depends on (never a global install). */
export function engineBin() {
  const require = createRequire(import.meta.url);
  let dir = dirname(require.resolve("openclaw"));
  for (let i = 0; i < 8; i++) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      const p = JSON.parse(readFileSync(pj, "utf8"));
      if (p.name === "openclaw") return { bin: join(dir, typeof p.bin === "string" ? p.bin : p.bin.openclaw), version: p.version, dir };
    }
    dir = dirname(dir);
  }
  throw new Error("the engine dependency is not installed (run npm install)");
}

/** Run the engine CLI and capture output (used by setup/doctor). */
export function engineCapture(args, { timeoutMs = 120000, env = process.env } = {}) {
  const r = spawnSync(process.execPath, [engineBin().bin, ...args], { env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
}

/** Run the engine CLI attached to the terminal; resolves with its exit code. Signals are forwarded. */
export function engineRun(args, { cwd, ownBanner = false } = {}) {
  return new Promise((resolve) => {
    // The engine draws its own banner only when stdout is a terminal. With `ownBanner` we hand it pipes
    // (and keep colours on) and forward the output, so only Ferrum's banner is shown.
    const env = ownBanner && process.stdout.isTTY && !process.env.NO_COLOR ? { ...process.env, FORCE_COLOR: "1" } : process.env;
    const child = spawn(process.execPath, [engineBin().bin, ...args], { stdio: ownBanner ? ["inherit", "pipe", "pipe"] : "inherit", cwd, env });
    if (ownBanner) { child.stdout.pipe(process.stdout, { end: false }); child.stderr.pipe(process.stderr, { end: false }); }
    const fwd = (sig) => () => { try { child.kill(sig); } catch {} };
    const handlers = { SIGINT: fwd("SIGINT"), SIGTERM: fwd("SIGTERM"), SIGHUP: fwd("SIGHUP") };
    for (const [s, h] of Object.entries(handlers)) process.on(s, h);
    child.on("close", (code, sig) => { for (const [s, h] of Object.entries(handlers)) process.off(s, h); resolve(code ?? (sig ? 1 : 0)); });
    child.on("error", (e) => { console.error(`ferrum: cannot start the engine: ${e.message}`); resolve(1); });
  });
}
