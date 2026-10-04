# Ferrum

Личный многоцелевой ИИ-агент. Надстройка над [OpenClaw](https://github.com/openclaw/openclaw) (MIT), а не его переписывание: штатное берём как есть, свой код (TypeScript-плагины, навыки, конфиг, скрипты) пишем только там, где OpenClaw не хватает.

Цель: Windows 11, шлюз внутри WSL2 (Ubuntu 24.04, не root), общение через Telegram. Позже Linux (Arch).

**Статус: этап 2 написан (режимы sandbox/local, политика, подтверждения, аудит), ждёт ручной проверки в Telegram.** Этап 1 проверен на настоящем Docker (изоляция 51/51), см. `docs/STAGE1.md`. Что доказано автоматически и что нет: `docs/STAGE2.md`.

## Что внутри

| Путь | Назначение |
| --- | --- |
| `docs/OPENCLAW_NOTES.md` | итоги разведки: что умеет OpenClaw, что писать самим, риски, решение по контейнерному бэкенду |
| `docs/OPENCLAW_LICENSE.md` | лицензия OpenClaw и зависимостей |
| `tests/contract/` | проверки допущений о закреплённой версии OpenClaw |
| `scripts/wsl/` | скрипты для WSL (preflight, Node, установка) |
| `scripts/windows/` | preflight для Windows (только чтение) |
| `scripts/license-scan.mjs` | подсчёт лицензий зависимостей |
| `docs/STAGE1.md` | порядок установки этапа 1 и что проверено, а что нет |
| `config/ferrum.baseline.json5` | базовый конфиг OpenClaw: шлюз на loopback, Docker-песочница, Telegram только для владельца |
| `docker/sandbox/` | Dockerfile образа песочницы |
| `tests/isolation/` | тест: команды идут в контейнер и не видят хост (+ негативные контроли) |
| `scripts/check-config.mjs` | статические инварианты безопасности конфига |
| `plugins/ferrum/` | плагин OpenClaw: `/mode`, инструменты `local_*`, политика, подтверждения, аудит (этап 2) |
| `docs/STAGE2.md` | как устроен этап 2, что доказано, ограничения, ручная проверка в Telegram |
| `tests/plugin/`, `tests/integration/` | юнит-тесты плагина и тест с настоящим шлюзом и поддельной моделью |
| `skills/` | пока пусто, заполняется на следующих этапах |

## Как проверить этап 0

Ничего не меняет в системе, кроме `node_modules` в репозитории.

1. **Windows (PowerShell, не от администратора):**
   `powershell -ExecutionPolicy Bypass -File scripts\windows\00-preflight.ps1`
   (скрипт только читает; на Windows он ещё не запускался, пришли вывод)
2. **WSL (Ubuntu 24.04):** `bash scripts/wsl/00-preflight.sh`. Строки `[FAIL]` показывают, чего не хватает.
3. Если Node 24 нет: `bash scripts/wsl/05-install-node.sh` (ставит в домашний каталог, проверяет SHA256).
4. `bash scripts/wsl/10-install-openclaw.sh`: `npm ci` (без запуска install-скриптов зависимостей), проверка версии, контрактные тесты. `~/.openclaw` не трогает.
5. Только тесты: `npm run test:contract` (контрактные тесты, все должны пройти; `npm test` запускает ещё и тесты плагина), `npm run test:isolation:control` (без Docker), `npm run test:isolation` (нужен Docker).

Этап 1: см. `docs/STAGE1.md`.

## Принципы

- OpenClaw закреплён точной версией (`2026.9.7`), обновление только осознанное: контрактные тесты покажут, что изменилось.
- Секреты не попадают в песочницу и в workspace; `.env*` и `secrets/` в `.gitignore`.
- Сторонние навыки и плагины автоматически не ставятся.
- Форк ядра OpenClaw только после согласования.

Лицензия Ferrum: GNU GPL v3 или новее (`GPL-3.0-or-later`), см. `LICENSE`.
