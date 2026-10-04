import { homedir } from "node:os";
import { join } from "node:path";

export interface FerrumConfig {
  /** Windows folder that local_* tools may touch. */
  localRoot: string;
  /** Where that folder is visible from the gateway process (WSL: /mnt/d/Ferrum). */
  localRootMount: string;
  idleMinutes: number;
  confirmSeconds: number;
  execTimeoutSeconds: number;
  /** null = unlimited (the owner's choice). */
  maxToolCallsPerTurn: number | null;
  approvalTimeoutSeconds: number;
  auditDir: string;
  powershell: string;
  taskkill: string;
}

/** `D:\Ferrum` -> `/mnt/d/Ferrum` */
export function defaultMount(localRoot: string): string {
  const m = /^([A-Za-z]):[\\/]*(.*?)[\\/]*$/.exec(localRoot);
  if (!m) return localRoot;
  const rest = m[2].replace(/\\/g, "/");
  return `/mnt/${m[1].toLowerCase()}${rest ? "/" + rest : ""}`;
}

export function resolveConfig(raw: unknown): FerrumConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (k: string, d: string) => (typeof c[k] === "string" && (c[k] as string).length > 0 ? (c[k] as string) : d);
  const num = (k: string, d: number, min: number) => (typeof c[k] === "number" && Number.isFinite(c[k]) && (c[k] as number) >= min ? (c[k] as number) : d);
  const localRoot = str("localRoot", "D:\\Ferrum");
  return {
    localRoot,
    localRootMount: str("localRootMount", defaultMount(localRoot)),
    idleMinutes: num("idleMinutes", 10, 1),
    confirmSeconds: num("confirmSeconds", 60, 10),
    execTimeoutSeconds: num("execTimeoutSeconds", 120, 1),
    maxToolCallsPerTurn: c.maxToolCallsPerTurn === null || c.maxToolCallsPerTurn === undefined ? null : num("maxToolCallsPerTurn", 0, 1) || null,
    approvalTimeoutSeconds: Math.min(600, num("approvalTimeoutSeconds", 120, 10)),
    auditDir: str("auditDir", join(homedir(), ".ferrum", "audit")),
    powershell: str("powershell", "powershell.exe"),
    taskkill: str("taskkill", "taskkill.exe"),
  };
}
