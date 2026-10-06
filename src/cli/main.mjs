import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PKG_ROOT } from "./paths.mjs";
import { engineBin, engineRun } from "./engine.mjs";
import { CliError } from "./ui.mjs";
import { showBanner } from "./banner.mjs";

const HELP = `Ferrum {VERSION}: личный ИИ-агент в изолированной песочнице

Работа
  start              запустить Ferrum (окно держите открытым, остановка: Ctrl+C)
  status             запущен ли Ferrum и всё ли на месте
  audit [N] [--json] последние N записей журнала действий агента (по умолчанию 20)

Установка и настройка
  preflight          проверить компьютер (ничего не меняет)
  install-docker     установить Docker в Ubuntu (спросит подтверждение, нужен sudo)
  sandbox-image      собрать образ песочницы
  setup [--reset] [--no-key]
                     ввести токен бота и ключ модели (ввод скрыт), записать конфиг

Диагностика и обслуживание
  doctor             полная проверка установки (код 1, если что-то не так)
  info               где лежат файлы и какие версии стоят (секреты не показываются)
  update [--check] [--yes]
                     проверить и установить новую версию
  version            версии Ferrum, движка и Node.js
  engine <аргументы> служебная команда движка с тем же каталогом состояния
  help               эта справка

В чате с ботом: /mode local включает доступ к папке Windows, /mode sandbox выключает.
Подробнее: docs/DEVELOPERS.md
`;

function helpText() {
  const v = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version;
  return HELP.replace("{VERSION}", v);
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case undefined: case "help": case "--help": case "-h": showBanner(); process.stdout.write(helpText()); return 0;
      case "version": case "--version": case "-v": {
        const me = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
        console.log(`ferrum ${me.version}\nengine ${engineBin().version}\nnode ${process.versions.node}`);
        return 0;
      }
      case "preflight": return await (await import("./scripts.mjs")).runScript("00-preflight.sh");
      case "install-docker": return await (await import("./scripts.mjs")).runScript("20-install-docker.sh", rest);
      case "status": return await (await import("./status.mjs")).status();
      case "audit": return (await import("./audit.mjs")).audit(rest);
      case "info": return (await import("./info.mjs")).info();
      case "update": return await (await import("./update.mjs")).update(rest);
      case "setup": showBanner(); return await (await import("./setup.mjs")).setup(rest);
      case "doctor": return await (await import("./doctor.mjs")).doctor();
      case "start": return await (await import("./start.mjs")).start();
      case "sandbox-image": return (await import("./image.mjs")).sandboxImage();
      case "engine": return await engineRun(rest);
      default: console.error(`ferrum: unknown command '${cmd}'\n\n${helpText()}`); return 2;
    }
  } catch (e) {
    if (e instanceof CliError) { console.error(`ferrum: ${e.message}`); return 1; }
    throw e;
  }
}
