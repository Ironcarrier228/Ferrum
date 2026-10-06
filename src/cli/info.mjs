// `ferrum info`: where everything lives and which versions are installed. Never prints secrets.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { engineBin } from "./engine.mjs";
import { PKG_ROOT, auditDir, configFile, envFile, stateDir, workspaceDir } from "./paths.mjs";

export function info() {
  const me = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
  let localRoot = "D:\\Ferrum";
  try { localRoot = JSON5.parse(readFileSync(configFile(), "utf8"))?.plugins?.entries?.ferrum?.config?.localRoot ?? localRoot; } catch {}
  const yes = (p) => (existsSync(p) ? "есть" : "нет");
  const rows = [
    ["Версия Ferrum", me.version],
    ["Версия движка", engineBin().version],
    ["Node.js", process.versions.node],
    ["Установлен в", PKG_ROOT],
    ["Каталог состояния", `${stateDir()} (${yes(stateDir())})`],
    ["Конфиг", `${configFile()} (${yes(configFile())})`],
    ["Секреты", `${envFile()} (${yes(envFile())}; значения не показываются)`],
    ["Рабочая папка агента", `${workspaceDir()} (${yes(workspaceDir())})`],
    ["Журнал действий", `${auditDir()} (${yes(auditDir())})`],
    ["Папка Windows для режима local", localRoot],
    ["Панель и API", "http://127.0.0.1:18789/ (только с этого компьютера, по токену)"],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v] of rows) console.log(`${k.padEnd(w)}  ${v}`);
  return 0;
}
