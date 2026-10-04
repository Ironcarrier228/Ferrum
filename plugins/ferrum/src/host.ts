// What local_* tools actually do on the Windows side. Files go through the gateway's own fs (via the drive mount),
// commands through powershell.exe (WSL interop). Every path was already canonicalised by policy/paths.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { resolveInRoot, toHostPath } from "./paths.ts";
import type { FerrumConfig } from "./config.ts";

const MAX_READ = 1024 * 1024;

export class HostError extends Error {}

export function hostPathFor(cfg: FerrumConfig, input: unknown): { host: string; win: string; rel: string } {
  const p = resolveInRoot(input, cfg.localRoot);
  if (!p.ok) throw new HostError(`path refused: ${p.reason}`);
  return { host: toHostPath(p.rel, cfg.localRootMount), win: p.win, rel: p.rel };
}

/** Refuse symlinks anywhere between the root and the target, and anything whose real path leaves the root. */
function assertNoEscape(cfg: FerrumConfig, host: string): void {
  const root = realpathSync(cfg.localRootMount);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  let cur = cfg.localRootMount.replace(/\/+$/, "");
  const rel = host.slice(cur.length).split("/").filter(Boolean);
  for (const seg of rel) {
    cur = `${cur}/${seg}`;
    let st;
    try { st = lstatSync(cur); } catch { return; } // does not exist yet: nothing to follow
    if (st.isSymbolicLink()) throw new HostError("symbolic links are not followed");
  }
  let probe = host;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  if (real !== root && !real.startsWith(rootWithSep)) throw new HostError("resolved path leaves the allowed folder");
}

export function existsRel(cfg: FerrumConfig, rel: string): boolean {
  try { return existsSync(toHostPath(rel, cfg.localRootMount)); } catch { return false; }
}

export function readFile(cfg: FerrumConfig, path: unknown): string {
  const { host, win } = hostPathFor(cfg, path);
  assertNoEscape(cfg, host);
  const st = statSync(host);
  if (!st.isFile()) throw new HostError(`${win} is not a file`);
  if (st.size > MAX_READ) throw new HostError(`${win} is larger than 1 MB`);
  return readFileSync(host, "utf8");
}

export function listDir(cfg: FerrumConfig, path: unknown): string {
  const { host, win } = hostPathFor(cfg, path ?? ".");
  assertNoEscape(cfg, host);
  const names = readdirSync(host, { withFileTypes: true }).slice(0, 500).map((e) => (e.isDirectory() ? `${e.name}\\` : e.name));
  return `${win}\n${names.join("\n")}`;
}

export function writeFile(cfg: FerrumConfig, path: unknown, content: string): string {
  const { host, win, rel } = hostPathFor(cfg, path);
  if (!rel) throw new HostError("cannot write to the root folder itself");
  assertNoEscape(cfg, dirname(host));
  mkdirSync(dirname(host), { recursive: true });
  assertNoEscape(cfg, host);
  writeFileSync(host, content, "utf8");
  return `${win}: wrote ${Buffer.byteLength(content, "utf8")} bytes`;
}

export function deletePath(cfg: FerrumConfig, path: unknown, recursive: boolean): string {
  const { host, win, rel } = hostPathFor(cfg, path);
  if (!rel) throw new HostError("cannot delete the root folder itself");
  assertNoEscape(cfg, host);
  const st = lstatSync(host);
  if (st.isDirectory() && !recursive) {
    if (readdirSync(host).length > 0) throw new HostError(`${win} is a non-empty folder; pass recursive=true`);
  }
  rmSync(host, { recursive: st.isDirectory(), force: false });
  return `${win}: deleted`;
}

export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

const MAX_OUT = 64 * 1024;

/** powershell.exe via WSL interop. The first output line carries the Windows PID so a timeout can kill the whole tree. */
export function execPowershell(cfg: FerrumConfig, command: string, signal?: AbortSignal): Promise<ExecResult> {
  return new Promise((resolve) => {
    const wrapped = `[Console]::Out.WriteLine('FERRUM_PID=' + $PID); ${command}`;
    const child = spawn(cfg.powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Restrict", "-Command", wrapped], {
      cwd: cfg.localRootMount, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    let stdout = "", stderr = "", winPid: string | null = null, timedOut = false, done = false;
    const cap = (s: string) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + "\n…[truncated]" : s);
    child.stdout.on("data", (d) => { if (stdout.length < MAX_OUT * 2) stdout += d; if (!winPid) { const m = /FERRUM_PID=(\d+)/.exec(stdout); if (m) { winPid = m[1]; stdout = stdout.replace(/FERRUM_PID=\d+\r?\n?/, ""); } } });
    child.stderr.on("data", (d) => { if (stderr.length < MAX_OUT * 2) stderr += d; });
    const kill = () => {
      if (winPid) spawnSync(cfg.taskkill, ["/PID", winPid, "/T", "/F"], { timeout: 10000 });
      try { child.kill("SIGKILL"); } catch {}
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, cfg.execTimeoutSeconds * 1000);
    const onAbort = () => { timedOut = true; kill(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve({ code, stdout: cap(stdout), stderr: cap(stderr), timedOut }); };
    child.on("error", (e) => { stderr += `\nspawn failed: ${e.message}`; finish(null); });
    child.on("close", (code) => finish(code));
  });
}

export function joinOutput(r: ExecResult): string {
  const parts = [r.timedOut ? "[TIMEOUT: the process tree was killed]" : `[exit ${r.code}]`];
  if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
  if (r.stderr.trim()) parts.push("[stderr]\n" + r.stderr.trimEnd());
  return parts.join("\n");
}
void join;
