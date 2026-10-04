import { randomInt } from "node:crypto";

export type Mode = "sandbox" | "local";

interface Entry { mode: Mode; lastActivity: number; pending?: { code: string; expires: number } }

export interface ModeEvent { ev: "mode_change" | "mode_expired" | "mode_confirm_requested" | "mode_confirm_failed"; session: string; from?: Mode; to?: Mode; detail?: string }

/** In-memory on purpose: a gateway restart always lands in sandbox. */
export class ModeStore {
  private s = new Map<string, Entry>();
  private idleMs: number;
  private confirmMs: number;
  private now: () => number;
  private emit: (e: ModeEvent) => void;
  constructor(idleMs: number, confirmMs: number, now: () => number = Date.now, emit: (e: ModeEvent) => void = () => {}) {
    this.idleMs = idleMs; this.confirmMs = confirmMs; this.now = now; this.emit = emit;
  }

  private get(key: string): Entry {
    let e = this.s.get(key);
    if (!e) { e = { mode: "sandbox", lastActivity: this.now() }; this.s.set(key, e); }
    return e;
  }

  /** Effective mode. Expiry is evaluated here, so nothing depends on a timer firing. */
  mode(key: string): Mode {
    const e = this.s.get(key);
    if (!e) return "sandbox";
    if (e.mode === "local" && this.now() - e.lastActivity > this.idleMs) {
      e.mode = "sandbox";
      this.emit({ ev: "mode_expired", session: key, from: "local", to: "sandbox", detail: `idle > ${Math.round(this.idleMs / 60000)} min` });
    }
    return e.mode;
  }

  /** Called on every local tool call and every /mode command: keeps an active local session alive. */
  touch(key: string) { const e = this.s.get(key); if (e && e.mode === "local") e.lastActivity = this.now(); }

  idleLeftMs(key: string): number { const e = this.s.get(key); return e && this.mode(key) === "local" ? Math.max(0, this.idleMs - (this.now() - e.lastActivity)) : 0; }

  setSandbox(key: string): boolean {
    const e = this.get(key);
    const was = this.mode(key);
    e.mode = "sandbox"; e.pending = undefined; e.lastActivity = this.now();
    if (was !== "sandbox") this.emit({ ev: "mode_change", session: key, from: was, to: "sandbox" });
    return was !== "sandbox";
  }

  /** Step 1 of /mode local: returns the code the owner must repeat. */
  requestLocal(key: string): string {
    const e = this.get(key);
    const code = String(randomInt(1000, 10000));
    e.pending = { code, expires: this.now() + this.confirmMs };
    this.emit({ ev: "mode_confirm_requested", session: key });
    return code;
  }

  /** Step 2: constant-time-ish compare; a wrong code burns the pending request. */
  confirmLocal(key: string, code: string): { ok: true } | { ok: false; reason: string } {
    const e = this.get(key);
    const p = e.pending;
    e.pending = undefined;
    if (!p) return { ok: false, reason: "no pending request: send /mode local first" };
    if (this.now() > p.expires) { this.emit({ ev: "mode_confirm_failed", session: key, detail: "expired" }); return { ok: false, reason: "the code has expired: send /mode local again" }; }
    if (code.trim() !== p.code) { this.emit({ ev: "mode_confirm_failed", session: key, detail: "wrong code" }); return { ok: false, reason: "wrong code: the request was cancelled, send /mode local again" }; }
    const was = e.mode;
    e.mode = "local"; e.lastActivity = this.now();
    if (was !== "local") this.emit({ ev: "mode_change", session: key, from: was, to: "local" });
    return { ok: true };
  }
}

export function parseModeArgs(args: string | undefined): { kind: "status" } | { kind: "sandbox" } | { kind: "local" } | { kind: "confirm"; code: string } | { kind: "bad"; text: string } {
  const a = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (a.length === 0) return { kind: "status" };
  if (a.length === 1 && a[0] === "sandbox") return { kind: "sandbox" };
  if (a.length === 1 && a[0] === "local") return { kind: "local" };
  if (a.length === 2 && a[0] === "confirm" && /^\d{4}$/.test(a[1])) return { kind: "confirm", code: a[1] };
  return { kind: "bad", text: "Использование: /mode, /mode sandbox, /mode local, /mode confirm <код>" };
}

/** `telegram:123` entries of commands.ownerAllowFrom -> is this channel sender an owner? */
export function isOwnerSender(cfg: any, channel: string | undefined, senderId: string | undefined): boolean {
  if (!channel || !senderId) return false;
  const list = cfg?.commands?.ownerAllowFrom;
  if (!Array.isArray(list)) return false;
  return list.some((x: unknown) => typeof x === "string" && x.toLowerCase() === `${channel}:${senderId}`.toLowerCase());
}
