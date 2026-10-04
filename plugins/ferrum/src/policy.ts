import { resolveInRoot, normalizeRoot } from "./paths.ts";

export type Decision =
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "approve"; title: string; description: string; severity: "info" | "warning" | "critical" };

export interface PolicyEnv {
  localRoot: string;
  /** does a file/dir exist at this path relative to the root? */
  exists: (relWinPath: string) => boolean;
}

export const LOCAL_TOOLS = ["local_read", "local_list", "local_write", "local_delete", "local_exec"] as const;
export const isLocalTool = (name: string) => name.startsWith("local_");

/** Sessions that must never get host access: unattended or delegated runs. */
export function sessionEligibleForLocal(sessionKey: string | undefined): { ok: true } | { ok: false; reason: string } {
  if (!sessionKey) return { ok: false, reason: "no session key" };
  const k = sessionKey.toLowerCase();
  if (/(^|:)cron(:|$)/.test(k)) return { ok: false, reason: "cron sessions never get local mode" };
  if (/(^|:)(subagent|spawn|acp|hook|heartbeat)(:|$)/.test(k)) return { ok: false, reason: "sub-agent / background sessions never get local mode" };
  return { ok: true };
}

const MAX_COMMAND = 400; // the approval prompt shows at most 512 chars: the owner must see the WHOLE command

// Safety net, not a boundary: PowerShell can obfuscate anything. The boundary is the owner's approval of the exact
// command text, and a hard cap on its length. These patterns refuse the obvious escapes even before asking.
const EXEC_DENY: Array<[RegExp, string]> = [
  [/(^|\s)-(e|ec|enc|encodedcommand)(\s|$)/i, "encoded commands are refused"],
  [/frombase64string|\[convert\]::/i, "base64 decoding is refused"],
  [/\b(invoke-expression|iex)\b/i, "Invoke-Expression is refused"],
  [/\\\\[^\s\\]|\/\/[a-z0-9.$_-]+\/|\\\\\?\\|\\\\\.\\/i, "UNC / device paths are refused"],
  [/\bwsl(\.exe)?\b|\\\\wsl[.$]/i, "wsl.exe would reach the Linux side with the gateway's secrets"],
  [/\.\.[\\/]/, "'..' in a command is refused"],
  [/\$env:|%[a-z_]+%|\$home\b|(^|\s)~[\\/]?(\s|$)|\[environment\]::/i, "environment/profile paths are refused"],
  [/\b(format-volume|diskpart|bcdedit|clear-disk|remove-partition|initialize-disk)\b|(^|\s)format\s+[a-z]:/i, "disk management is refused"],
  [/\breg(\.exe)?\s+(add|delete|import|load|save|restore)\b|\bset-itemproperty\s+.*hk(lm|cu|cr)/i, "registry changes are refused"],
  [/\b(set-executionpolicy|new-service|set-service|schtasks|sc(\.exe)?\s+(create|config)|net(\.exe)?\s+(user|localgroup)|new-localuser|add-localgroupmember)\b/i, "system configuration commands are refused"],
  [/-verb\s+runas|\bstart-process\b[^|;]*-verb/i, "elevation is refused"],
  [/\b(shutdown|restart-computer|stop-computer)\b/i, "power commands are refused"],
  [/\bget-content\b[^|;]*\b(id_rsa|\.ssh|\.openclaw|\.env)\b|\.ssh\b|\.openclaw\b|\.aws\b|\.kube\b/i, "credential locations are refused"],
];

/** Drive-letter paths inside a command must stay inside the allowed folder. */
function foreignPaths(cmd: string, root: string): string | null {
  const r = normalizeRoot(root);
  for (const m of cmd.matchAll(/(?<![A-Za-z0-9_])([A-Za-z]):[\\/][^\s"'`|;&<>)]*/g)) {
    const res = resolveInRoot(m[0], root);
    if (!res.ok) return `${m[0]} (${res.reason})`;
  }
  if (/(?<![A-Za-z0-9_])\/mnt\/[a-z](\/|\s|$)/i.test(cmd)) {
    for (const m of cmd.matchAll(/\/mnt\/[a-z](\/[^\s"'`|;&<>)]*)?/gi)) {
      const res = resolveInRoot(m[0], root);
      if (!res.ok) return `${m[0]} (${res.reason})`;
    }
  }
  void r;
  return null;
}

const short = (s: string, n = 380) => (s.length > n ? s.slice(0, n) + "…" : s);

export function decideLocal(tool: string, params: Record<string, unknown>, env: PolicyEnv): Decision {
  switch (tool) {
    case "local_read":
    case "local_list": {
      const p = resolveInRoot(params.path ?? (tool === "local_list" ? "." : undefined), env.localRoot);
      return p.ok ? { action: "allow" } : { action: "block", reason: `path refused: ${p.reason}` };
    }
    case "local_write": {
      const p = resolveInRoot(params.path, env.localRoot);
      if (!p.ok) return { action: "block", reason: `path refused: ${p.reason}` };
      if (!p.rel) return { action: "block", reason: "cannot write to the root folder itself" };
      if (typeof params.content !== "string") return { action: "block", reason: "content must be a string" };
      if (Buffer.byteLength(params.content, "utf8") > 5 * 1024 * 1024) return { action: "block", reason: "content larger than 5 MB" };
      if (env.exists(p.rel)) {
        return { action: "approve", title: "Перезапись файла", description: `Перезаписать ${p.win} (${Buffer.byteLength(params.content, "utf8")} байт)?`, severity: "warning" };
      }
      return { action: "allow" };
    }
    case "local_delete": {
      const p = resolveInRoot(params.path, env.localRoot);
      if (!p.ok) return { action: "block", reason: `path refused: ${p.reason}` };
      if (!p.rel) return { action: "block", reason: "cannot delete the root folder itself" };
      return { action: "approve", title: "Удаление", description: `Удалить ${p.win}${params.recursive === true ? " вместе с содержимым" : ""}?`, severity: "critical" };
    }
    case "local_exec": {
      const cmd = params.command;
      if (typeof cmd !== "string" || cmd.trim().length === 0) return { action: "block", reason: "command must be a non-empty string" };
      if (cmd.length > MAX_COMMAND) return { action: "block", reason: `command is longer than ${MAX_COMMAND} characters; split it into steps so the owner can read all of it` };
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(cmd)) return { action: "block", reason: "control characters in command" };
      for (const [re, why] of EXEC_DENY) if (re.test(cmd)) return { action: "block", reason: why };
      const bad = foreignPaths(cmd, env.localRoot);
      if (bad) return { action: "block", reason: `path outside the allowed folder: ${bad}` };
      return { action: "approve", title: "Запуск команды на Windows", description: `Папка: ${normalizeRoot(env.localRoot).win}\n${cmd}`, severity: "critical" };
    }
    default:
      return { action: "block", reason: `unknown local tool ${tool}` };
  }
}
