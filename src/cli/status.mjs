// `ferrum status`: is Ferrum running and is everything it needs in place? Read-only, fast.
import net from "node:net";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dockerStatus } from "./doctor.mjs";
import { SANDBOX_IMAGE, auditDir, configFile, envFile, workspaceDir } from "./paths.mjs";
import { ok, warn, bad } from "./ui.mjs";

export const GATEWAY_PORT = 18789;

export function portOpen(port, host = "127.0.0.1", timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** Timestamp of the newest audit record, or null. */
export function lastAuditTime(dir = auditDir()) {
  try {
    const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    for (let i = files.length - 1; i >= 0; i--) {
      const lines = readFileSync(join(dir, files[i]), "utf8").split("\n").filter(Boolean);
      for (let j = lines.length - 1; j >= 0; j--) { try { const t = JSON.parse(lines[j]).ts; if (t) return t; } catch {} }
    }
  } catch {}
  return null;
}

export async function status() {
  const running = await portOpen(GATEWAY_PORT);
  running ? ok(`Ferrum запущен (127.0.0.1:${GATEWAY_PORT})`) : bad("Ferrum не запущен. Запустить: ferrum start");
  existsSync(configFile()) ? ok("конфиг на месте") : bad("нет конфига. Выполните: ferrum setup");
  existsSync(envFile()) ? ok("секреты на месте (значения не показываются)") : bad("нет файла секретов. Выполните: ferrum setup");
  existsSync(workspaceDir()) ? ok(`рабочая папка: ${workspaceDir()}`) : warn("рабочей папки ещё нет (создаёт ferrum setup)");
  const d = dockerStatus();
  if (!d.reachable) bad("Docker недоступен без sudo: песочница не запустится. Подробности: ferrum doctor");
  else d.image ? ok(`песочница готова (${SANDBOX_IMAGE})`) : bad("образ песочницы не собран. Выполните: ferrum sandbox-image");
  const t = lastAuditTime();
  console.log(t ? `  последнее действие в журнале: ${t}` : "  журнал действий пока пуст");
  return running ? 0 : 1;
}
