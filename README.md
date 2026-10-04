# Ferrum

Личный многоцелевой ИИ-агент: общение через Telegram, работа в изолированной Docker-песочнице, а по твоей команде (`/mode local`) ещё и в одной папке Windows с подтверждением опасных действий и журналом аудита.

Цель: Windows 11, шлюз внутри WSL2 (Ubuntu 24.04, не root). Позже Linux (Arch).

**Статус: этап 2 написан (режимы sandbox/local, политика, подтверждения, аудит), ждёт ручной проверки в Telegram.** Этап 1 проверен на настоящем Docker (изоляция 51/51), см. `docs/STAGE1.md`. Что доказано автоматически и что нет: `docs/STAGE2.md`.

## Установка как npm-пакет

```bash
# Node 24.16+ (scripts/wsl/05-install-node.sh ставит его в домашний каталог)
npm install -g --ignore-scripts @ironcarrier228/ferrum   # --ignore-scripts: не запускать установочные скрипты ~340 зависимостей
ferrum setup          # секреты (скрытый ввод) -> ~/.openclaw/.env (600), конфиг -> ~/.openclaw/openclaw.json
ferrum sandbox-image  # собрать Docker-образ песочницы
ferrum doctor         # проверка, ничего не меняет
ferrum start          # шлюз на 127.0.0.1:18789 в этом терминале
```

Остальные команды: `ferrum engine <аргументы>` (нижележащий CLI с тем же каталогом состояния), `ferrum version`, `ferrum help`.
Подготовка WSL, Docker и Windows (preflight, установка Docker Engine, перенос дистрибутива на другой диск) лежит в пакете в `scripts/wsl/` и `scripts/windows/`, порядок в `docs/STAGE1.md`.

## Работа из репозитория

`bash scripts/wsl/10-install-deps.sh` (`npm ci` + контрактные тесты), затем те же команды: `node bin/ferrum.mjs <команда>` или `npm run ferrum -- <команда>`.

## Что внутри

| Путь | Назначение |
| --- | --- |
| `bin/ferrum.mjs`, `src/cli/` | команда `ferrum`: setup, doctor, start, sandbox-image, engine |
| `src/check-config.mjs` | статические инварианты безопасности конфига (их проверяют setup, doctor и start) |
| `config/ferrum.baseline.json5` | базовый конфиг: шлюз на loopback, Docker-песочница, Telegram только для владельца, плагин ferrum |
| `plugins/ferrum/` | плагин: `/mode`, инструменты `local_*`, политика, подтверждения, аудит (этап 2) |
| `docker/sandbox/` | Dockerfile образа песочницы |
| `scripts/wsl/`, `scripts/windows/` | подготовка WSL, Docker, Node; preflight (только чтение) |
| `docs/STAGE1.md`, `docs/STAGE2.md` | порядок установки, что проверено, ограничения, ручная проверка |
| `docs/THIRD_PARTY_LICENSES.md` | лицензии зависимостей |
| `tests/contract/` | проверки допущений о закреплённой версии зависимости и о конфиге |
| `tests/plugin/`, `tests/cli/`, `tests/package/` | юнит-тесты плагина, команды `ferrum` и состава пакета |
| `tests/integration/` | настоящий шлюз с поддельной моделью, без Docker и Telegram |
| `tests/isolation/` | команды идут в контейнер и не видят хост (+ негативные контроли), нужен Docker |
| `skills/` | пока пусто |

## Проверки

`npm test` (без сети и Docker), `npm run test:plugin:integration`, `npm run test:isolation:control` (без Docker), `npm run test:isolation` (нужен Docker), `npm run test:package:install` (ставит собранный пакет во временный каталог и прогоняет его).

## Принципы

- Базовый движок закреплён точной версией (`2026.9.7`), обновление только осознанное: контрактные тесты покажут, что изменилось. Ядро не копируется и не форкается (форк только после согласования).
- Секреты не попадают в песочницу и в workspace; `.env*` и `secrets/` в `.gitignore`.
- Сторонние навыки и плагины автоматически не ставятся.

Лицензия Ferrum: GNU GPL v3 или новее (`GPL-3.0-or-later`), см. `LICENSE`. Лицензии зависимостей: `docs/THIRD_PARTY_LICENSES.md`.
