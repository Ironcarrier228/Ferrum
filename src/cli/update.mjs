// `ferrum update [--check] [--yes]`: compare with the latest published version and, if newer, install it.
import { spawnSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PKG_ROOT } from "./paths.mjs";
import { ask, CliError } from "./ui.mjs";

const PKG = "@ironcarrier228/ferrum";

/** true if version a is newer than b (plain x.y.z, pre-release suffixes ignored). */
export function isNewer(a, b) {
  const p = (v) => String(v).split("-")[0].split(".").map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

export async function update(args) {
  const known = ["--check", "--yes"];
  if (args.some((a) => !known.includes(a))) throw new CliError("использование: ferrum update [--check] [--yes]");
  const current = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version;
  const r = spawnSync("npm", ["view", PKG, "version", "--prefer-online"], { encoding: "utf8", timeout: 60000 });
  const latest = (r.stdout ?? "").trim().split("\n").pop();
  if (r.error || r.status !== 0 || !/^\d+\.\d+\.\d+/.test(latest)) throw new CliError("не удалось узнать последнюю версию (нет сети или npm недоступен)");
  console.log(`Установлена версия ${current}, последняя ${latest}.`);
  if (!isNewer(latest, current)) { console.log("Обновление не нужно."); return 0; }
  if (args.includes("--check")) { console.log("Доступна новая версия. Обновить: ferrum update"); return 0; }
  if (!args.includes("--yes")) {
    const a = (await ask("Обновить сейчас? [y/N]")).trim().toLowerCase();
    if (a !== "y" && a !== "yes") { console.log("Отменено."); return 0; }
  }
  const code = await new Promise((resolve) => {
    const c = spawn("npm", ["install", "-g", "--ignore-scripts", "--prefer-online", PKG], { stdio: "inherit" });
    c.on("close", (x) => resolve(x ?? 1)); c.on("error", () => resolve(1));
  });
  if (code !== 0) throw new CliError("обновление не удалось (см. сообщение npm выше)");
  console.log("\nГотово. Дальше:\n  1. ferrum setup    (обновит конфиг; секреты и токен сохранятся)\n  2. перезапустите Ferrum: Ctrl+C в окне, где работает ferrum start, и снова ferrum start");
  return 0;
}
