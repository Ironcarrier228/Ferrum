# Ferrum: для разработчиков

Здесь собрано всё техническое. Обычная инструкция для пользователя: [README.md](../README.md).

Личный многоцелевой ИИ-агент: общение через Telegram, работа в изолированной Docker-песочнице, а по твоей команде (`/mode local`) ещё и в одной папке Windows с подтверждением опасных действий и журналом аудита.

Цель: Windows 11, шлюз внутри WSL2 (Ubuntu 24.04, не root). Позже Linux (Arch).

**Статус: этап 2 написан (режимы sandbox/local, политика, подтверждения, аудит), ждёт ручной проверки в Telegram.** Этап 1 проверен на настоящем Docker (изоляция 51/51), см. [STAGE1.md](STAGE1.md). Что доказано автоматически и что нет: [STAGE2.md](STAGE2.md).

## Установка как npm-пакет

```bash
# Node 24.16+ (scripts/wsl/05-install-node.sh ставит его в домашний каталог)
npm install -g --ignore-scripts @ironcarrier228/ferrum   # --ignore-scripts: не запускать установочные скрипты ~340 зависимостей
ferrum preflight      # проверка компьютера, ничего не меняет (scripts/wsl/00-preflight.sh)
ferrum install-docker # Docker Engine в WSL, спросит подтверждение, нужен sudo (scripts/wsl/20-install-docker.sh)
ferrum setup          # секреты (скрытый ввод) -> ~/.openclaw/.env (600), конфиг -> ~/.openclaw/openclaw.json
ferrum sandbox-image  # собрать Docker-образ песочницы
ferrum doctor         # проверка, ничего не меняет
ferrum start          # шлюз на 127.0.0.1:18789 в этом терминале
```

Остальные команды: `ferrum engine <аргументы>` (нижележащий CLI с тем же каталогом состояния), `ferrum version`, `ferrum help`.
Подготовка WSL, Docker и Windows (preflight, установка Docker Engine, перенос дистрибутива на другой диск) лежит в пакете в `scripts/wsl/` и `scripts/windows/`, порядок в [STAGE1.md](STAGE1.md).

## Работа из репозитория

`bash scripts/wsl/10-install-deps.sh` (`npm ci` + контрактные тесты), затем те же команды: `node bin/ferrum.mjs <команда>` или `npm run ferrum -- <команда>`.

## Что внутри

| Путь | Назначение |
| --- | --- |
| `bin/ferrum.mjs`, `src/cli/` | команда `ferrum`: setup, doctor, start, sandbox-image, preflight, install-docker, engine |
| `src/check-config.mjs` | статические инварианты безопасности конфига (их проверяют setup, doctor и start) |
| `config/ferrum.baseline.json5` | базовый конфиг: шлюз на loopback, Docker-песочница, Telegram только для владельца, плагин ferrum |
| `plugins/ferrum/` | плагин: `/mode`, инструменты `local_*`, политика, подтверждения, аудит (этап 2) |
| `docker/sandbox/` | Dockerfile образа песочницы |
| `scripts/wsl/`, `scripts/windows/` | подготовка WSL, Docker, Node; preflight (только чтение) |
| `docs/STAGE1.md`, `docs/STAGE2.md` | порядок установки, что проверено, ограничения, ручная проверка |
| `docs/THIRD_PARTY_LICENSES.md` | лицензии зависимостей |
| `docs/CREDITS.md` | на чём основан проект |
| `tests/contract/` | проверки допущений о закреплённой версии зависимости и о конфиге |
| `tests/plugin/`, `tests/cli/`, `tests/package/` | юнит-тесты плагина, команды `ferrum` и состава пакета |
| `tests/integration/` | настоящий шлюз с поддельной моделью, без Docker и Telegram |
| `tests/isolation/` | команды идут в контейнер и не видят хост (+ негативные контроли), нужен Docker |
| `skills/` | пока пусто |

## Режимы

- **sandbox** (по умолчанию, `agents.defaults.sandbox.mode: "all"`): все сессии, включая cron и подагентов, выполняют инструменты в Docker-контейнере. Образ `ferrum-sandbox:bookworm-slim`, пользователь uid/gid хоста, корень только для чтения, `CapDrop ALL`, `no-new-privileges`, сеть `none`, память 1 ГБ, 256 процессов. Смонтирован только workspace (`~/ferrum/workspace` -> `/workspace`, чтение и запись) и проекция навыков только для чтения. Что проверено: [STAGE1.md](STAGE1.md).
- **local**: включается командой `/mode local` + код подтверждения (только владелец). Доступ к `D:\Ferrum` (`/mnt/d/Ferrum` в WSL) только через инструменты `local_read`, `local_list`, `local_write`, `local_delete`, `local_exec`; опасные действия идут через подтверждение кнопками в Telegram; выход: `/mode sandbox` или 10 минут простоя. Подробно: [STAGE2.md](STAGE2.md).

## Конфиг

- Шаблон: `config/ferrum.baseline.json5`. `ferrum setup` подставляет его в `~/.openclaw/openclaw.json` (локально изменённый конфиг сохраняется как `*.bak.*`). Секреты в конфиге не хранятся: только ссылки вида `${ИМЯ}`.
- Шлюз: `127.0.0.1:18789`, доступ по токену (`gateway.auth.mode: "token"`).
- Telegram: `dmPolicy: "allowlist"`, только твой числовой id, группы отключены, кнопки подтверждений в личных сообщениях.
- Плагины: белый список `telegram`, `ferrum`; плагин грузится через `plugins.load.paths` из `${FERRUM_REPO}/plugins/ferrum`.
- Параметры плагина (`plugins.entries.ferrum.config`, умолчания в `plugins/ferrum/src/config.ts`): `localRoot` (`D:\Ferrum`), `localRootMount` (`/mnt/d/Ferrum`), `idleMinutes` (10), `confirmSeconds` (60), `execTimeoutSeconds` (120), `maxToolCallsPerTurn` (без лимита), `approvalTimeoutSeconds` (120, максимум 600), `auditDir` (`~/.ferrum/audit`), `powershell`, `taskkill`.
- Инварианты безопасности конфига проверяет `src/check-config.mjs` (вызывается из `setup`, `doctor` и `start`; `start` отказывается запускаться при нарушении).

## Переменные окружения

Секреты и настройки лежат в `~/.openclaw/.env` (права 600), вне репозитория и вне workspace:

| Переменная | Назначение |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | токен бота |
| `FERRUM_TELEGRAM_USER_ID` | числовой id владельца |
| `FERRUM_MODEL_ID` | id модели |
| `FERRUM_MODEL_API_KEY` | ключ модели |
| `OPENCLAW_GATEWAY_TOKEN` | токен доступа к шлюзу (создаётся при `setup`, существующий сохраняется) |
| `FERRUM_REPO` | корень пакета или репозитория (`doctor` отказывает, если не совпадает с реальным) |
| `FERRUM_SANDBOX_UID`, `FERRUM_SANDBOX_GID` | uid/gid, под которыми работает песочница |

Для неинтерактивного `ferrum setup` те же `TELEGRAM_BOT_TOKEN`, `FERRUM_TELEGRAM_USER_ID`, `FERRUM_MODEL_ID`, `FERRUM_MODEL_API_KEY` можно передать окружением. Флаги: `--reset` (пересоздать конфиг), `--no-key` (без ключа модели).
Только для тестов и скриптов: `FERRUM_TEST_TIMEOUT_X` (множитель ожиданий изоляционного теста, по умолчанию 3), `FERRUM_PKG_DIR`, `FERRUM_ENGINE_BIN` (интеграционные тесты против установленного пакета), `FERRUM_WORKSPACE` (preflight).

## Устройство папок на машине

| Путь | Что там |
| --- | --- |
| `~/.openclaw/` | каталог состояния: `.env` (секреты, 600), `openclaw.json` (конфиг), сессии и журналы шлюза |
| `~/ferrum/workspace/` | рабочая папка агента в песочнице (`/workspace` в контейнере); на файловой системе Linux, не на `/mnt/c` |
| `~/.ferrum/audit/` | журнал аудита `YYYY-MM-DD.jsonl` (каталог 700, файлы 600), вне workspace и песочницы |
| `D:\Ferrum` (`/mnt/d/Ferrum`) | единственная папка Windows, доступная в режиме local |

## Проверки

`npm test` (без сети и Docker), `npm run test:plugin:integration`, `npm run test:isolation:control` (без Docker), `npm run test:isolation` (нужен Docker), `npm run test:package:install` (ставит собранный пакет во временный каталог и прогоняет его).

## Принципы

- Базовый движок закреплён точной версией (`2026.9.7`), обновление только осознанное: контрактные тесты покажут, что изменилось. Ядро не копируется и не форкается (форк только после согласования).
- Секреты не попадают в песочницу и в workspace; `.env*` и `secrets/` в `.gitignore`.
- Сторонние навыки и плагины автоматически не ставятся.

Лицензия Ferrum: GNU GPL v3 или новее (`GPL-3.0-or-later`), см. `LICENSE`. Лицензии зависимостей: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md). На чём основан проект: [CREDITS.md](CREDITS.md).
