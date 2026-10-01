# Ferrum

Личный многоцелевой ИИ-агент. Надстройка над [OpenClaw](https://github.com/openclaw/openclaw) (MIT), а не его переписывание: штатное берём как есть, свой код (TypeScript-плагины, навыки, конфиг, скрипты) пишем только там, где OpenClaw не хватает.

Цель: Windows 11, шлюз внутри WSL2 (Ubuntu 24.04, не root), общение через Telegram. Позже Linux (Arch).

**Статус: этап 0 (разведка и каркас).** Плагинов и рабочего агента пока нет.

## Что внутри

| Путь | Назначение |
| --- | --- |
| `docs/OPENCLAW_NOTES.md` | итоги разведки: что умеет OpenClaw, что писать самим, риски, решение по контейнерному бэкенду |
| `docs/OPENCLAW_LICENSE.md` | лицензия OpenClaw и зависимостей |
| `tests/contract/` | проверки допущений о закреплённой версии OpenClaw |
| `scripts/wsl/` | скрипты для WSL (preflight, Node, установка) |
| `scripts/windows/` | preflight для Windows (только чтение) |
| `scripts/license-scan.mjs` | подсчёт лицензий зависимостей |
| `config/`, `plugins/ferrum-policy/`, `plugins/ferrum-modes/`, `skills/` | пока пусто, заполняются на этапах 1–5 |

## Как проверить этап 0

Ничего не меняет в системе, кроме `node_modules` в репозитории.

1. **Windows (PowerShell, не от администратора):**
   `powershell -ExecutionPolicy Bypass -File scripts\windows\00-preflight.ps1`
   (скрипт только читает; на Windows он ещё не запускался, пришли вывод)
2. **WSL (Ubuntu 24.04):** `bash scripts/wsl/00-preflight.sh`. Строки `[FAIL]` показывают, чего не хватает.
3. Если Node 24 нет: `bash scripts/wsl/05-install-node.sh` (ставит в домашний каталог, проверяет SHA256).
4. `bash scripts/wsl/10-install-openclaw.sh`: `npm ci` (без запуска install-скриптов зависимостей), проверка версии, контрактные тесты. `~/.openclaw` не трогает.
5. Только тесты: `npm run test:contract` (ожидается 10 из 10).

## Принципы

- OpenClaw закреплён точной версией (`2026.9.7`), обновление только осознанное: контрактные тесты покажут, что изменилось.
- Секреты не попадают в песочницу и в workspace; `.env*` и `secrets/` в `.gitignore`.
- Сторонние навыки и плагины автоматически не ставятся.
- Форк ядра OpenClaw только после согласования.

Лицензия Ferrum: GNU GPL v3 или новее (`GPL-3.0-or-later`), см. `LICENSE`.
