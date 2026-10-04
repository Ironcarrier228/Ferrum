import { appendFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "<telegram-token>"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "<api-key>"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "<github-token>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<aws-key>"],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1<redacted>"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "<private-key>"],
  [/((?:api[_-]?key|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, "$1<redacted>"],
];

export function redact(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

const LIMIT = 2000;
export function sanitize(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "string") { const r = redact(v); return r.length > LIMIT ? `${r.slice(0, LIMIT)}…[+${r.length - LIMIT} chars]` : r; }
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (depth > 5) return "[deep]";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => sanitize(x, depth + 1));
  if (typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 50)) {
      o[k] = /^(api[_-]?key|token|secret|password|authorization|botToken)$/i.test(k) ? "<redacted>" : sanitize(x, depth + 1);
    }
    return o;
  }
  return String(v);
}

/** Append-only JSONL, one file per day, outside the workspace and never mounted into a sandbox. Never throws. */
export class Audit {
  private dir: string;
  private now: () => Date;
  constructor(dir: string, now: () => Date = () => new Date()) { this.dir = dir; this.now = now; }
  write(entry: Record<string, unknown>): void {
    try {
      if (!existsSync(this.dir)) { mkdirSync(this.dir, { recursive: true, mode: 0o700 }); try { chmodSync(this.dir, 0o700); } catch {} }
      const d = this.now();
      const file = join(this.dir, `${d.toISOString().slice(0, 10)}.jsonl`);
      const fresh = !existsSync(file);
      appendFileSync(file, JSON.stringify({ ts: d.toISOString(), ...(sanitize(entry) as object) }) + "\n", { mode: 0o600 });
      if (fresh) { try { chmodSync(file, 0o600); } catch {} }
    } catch (e) {
      // Audit must not break the gateway, but a silent failure is also bad: surface it on stderr.
      try { console.error(`[ferrum] audit write failed: ${(e as Error).message}`); } catch {}
    }
  }
}
