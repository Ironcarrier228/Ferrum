# Этап 1: Telegram + песочница Docker + тест изоляции

Конфигурация: `config/ferrum.baseline.json5` (копируется в `~/.openclaw/openclaw.json`).
Бэкенд песочницы: **Docker Engine внутри WSL** (без Docker Desktop). Модель: твой OpenAI-совместимый эндпойнт `http://localhost:20128/v1` (`openai-completions`), id модели и ключ вводишь сам.

## Что проверено в моей среде, а что нет

| Что | Статус |
| --- | --- |
| Конфиг валиден для OpenClaw 2026.9.7, `sandbox explain` показывает docker-песочницу, один mount `workspace -> /workspace`, elevated выключен | **запущено**, `tests/contract/baseline-config.test.mjs` (5 тестов) |
| 21 опасная правка конфига ловится статическими инвариантами (`scripts/check-config.mjs`) | **запущено** (негативные контроли) |
| Шлюз слушает только loopback, API без токена и с неверным токеном даёт 401 | **запущено**, `tests/isolation/run.mjs --control` |
| Без Docker ход агента **падает до обращения к модели**, на хост не откатывается (fail-closed) | **запущено** |
| Песочница выключена, а `tools.exec.host: "sandbox"`: `exec` отказывает («requires a sandbox runtime») | **запущено** |
| Негативный контроль: при намеренно сломанной конфигурации (`sandbox off` + `exec.host=gateway`) пробы **находят** утечки: нет `/.dockerenv`, виден файл-канарейка, фальшивый `.ssh`, `.env`, конфиг OpenClaw | **запущено** (19 из 19 проверок в режиме `--control`) |
| Модельный путь: шлюз -> кастомный провайдер `openai-completions` -> поддельная модель -> `exec` -> результат | **запущено** (на поддельном сервере, не на твоей модели) |
| Настоящая песочница в контейнере: около 40 проверок изоляции, включая `docker inspect` | **НЕ запущено**: в моей среде нет Docker. Тест написан и должен быть запущен у тебя |
| Telegram (бот, allowlist, кнопки) | **НЕ проверено**: нет сети до Telegram и нет токена |
| Скрипты `20`, `30`, `45`, `50` и Windows-скрипт `10-wsl-ubuntu-on-disk.ps1` | `bash -n` и частичные прогоны (`40`, `45`, `50` в ветках отказа); `20`, `30` и `.ps1` **не запускались** |
| Твоя модель: id, ключ, вызов инструментов | **не проверено**, это делает `45-check-model.sh` у тебя |

## Порядок установки (у тебя)

### 0. Windows: Ubuntu на другом диске
Нужна буква диска и ≥ 8 ГБ свободно. Обычный PowerShell, **не от администратора**:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\10-wsl-ubuntu-on-disk.ps1 -Path D:\WSL\Ferrum-Ubuntu            # проверка, ничего не меняет
powershell -ExecutionPolicy Bypass -File scripts\windows\10-wsl-ubuntu-on-disk.ps1 -Path D:\WSL\Ferrum-Ubuntu -Execute   # установка
```

Если Ubuntu-24.04 уже стоит на C:, скрипт покажет команды переноса (`wsl --export` / `--import`). Деструктивный шаг помечен.
Если модель крутится **в Windows** на `localhost:20128`, создай `%UserProfile%\.wslconfig` с `[wsl2]` и `networkingMode=mirrored`, затем `wsl --shutdown`. Иначе `localhost` из WSL не достанет до Windows (проверит шаг 6).

### 1. WSL: репозиторий, Node, OpenClaw
```bash
git clone https://github.com/Ironcarrier228/Ferrum ~/Ferrum && cd ~/Ferrum && git checkout arena/01a0f81e-ferrum
bash scripts/wsl/00-preflight.sh          # [FAIL] только про docker на этом шаге нормально
bash scripts/wsl/05-install-node.sh       # если нет Node 24 (затем: export PATH="$HOME/.local/bin:$PATH")
bash scripts/wsl/10-install-openclaw.sh   # npm ci + контрактные тесты (ожидается 15 из 15)
```

### 2. Docker Engine и образ песочницы
```bash
bash scripts/wsl/20-install-docker.sh     # sudo; покажет план и спросит подтверждение
# в PowerShell: wsl --terminate Ubuntu-24.04   (чтобы заработала группа docker), открой WSL снова
docker info                                # должно работать БЕЗ sudo
bash scripts/wsl/30-build-sandbox-image.sh
```
Группа `docker` в этом дистрибутиве равна root: поэтому дистрибутив выделенный, `docker.sock` никогда не монтируется в песочницу, а к Docker обращается только шлюз.

### 3. Бот Telegram
1. @BotFather -> `/newbot`, получи токен (в чат мне **не присылай**).
2. Твой числовой user id: проще всего @userinfobot (сторонний бот, видит твой id). Без третьих лиц: напиши своему боту любое сообщение, затем `curl https://api.telegram.org/bot<ТОКЕН>/getUpdates` и найди `"from":{"id":...}`.

### 4. Конфиг и секреты
```bash
bash scripts/wsl/40-configure.sh          # спросит токен бота (скрыто), id, id модели, ключ (скрыто)
```
Секреты попадают только в `~/.openclaw/.env` (права 600). В конфиге, репозитории и workspace их нет. Скрипт запускает проверку инвариантов, `config validate`, `sandbox explain` и `security audit`.

### 5. Тест изоляции (главное)
```bash
npm run test:isolation                     # реальный: нужен docker, код 0 = изолировано, 77 = пропущен (НЕ успех)
npm run test:isolation:control             # без docker: доказывает, что пробы умеют находить утечки
```
Что делает реальный тест, без твоей модели и без Telegram: поднимает одноразовый шлюз с **твоим** `config/ferrum.baseline.json5` (список тестовых подмен печатается), подставляет поддельную модель, которая просит `exec` с набором проб, и запускает настоящий ход агента. Проверяет изнутри контейнера: он действительно в контейнере (`/.dockerenv`), не root, нет файлов-канареек и фальшивых `.ssh` и `.env` хоста, нет `$HOME` хоста и `/mnt/c`, нет секретов шлюза в окружении, нет `docker.sock`, root только для чтения, `CapEff=0`, `no-new-privileges`, из сетевых устройств только `lo`, нет интернета и нет доступа к шлюзу и эндпойнту модели. И снаружи `docker inspect`: единственный mount это workspace, не privileged, сеть none, capDrop ALL и т. д. Плюс положительные контроли: workspace действительно виден и запись из контейнера появляется на хосте.

Возможная первая правка: если OpenClaw добавит ещё один mount (например, навыки только для чтения), проверка «единственный mount» упадёт и покажет список. Это сигнал решить, допустим ли он, а не повод ослаблять тест вслепую.

### 6. Модель и шлюз
```bash
bash scripts/wsl/45-check-model.sh        # доступность из WSL, id и ключ, умеет ли модель вызывать инструменты
bash scripts/wsl/50-run-gateway.sh        # шлюз на 127.0.0.1:18789 в этом терминале; Ctrl+C останавливает
```
Скрипт `50` откажется стартовать, если нарушены инварианты конфига, нет Docker или нет образа.

### 7. Ручная проверка в Telegram
- «Скажи ping»: ответ от модели.
- «Выполни `cat /etc/os-release; id; hostname`»: Debian 12, твой uid, hostname-контейнер.
- «Выполни `ls /home /mnt; env | head -50`»: нет твоего пользователя, нет `/mnt/c`, нет `TELEGRAM_BOT_TOKEN`.
- «Создай файл `hello.txt` в рабочей папке»: файл появляется в `~/ferrum/workspace` в WSL.
- Написать боту с другого аккаунта: ответа нет.

Ручной тест зависит от поведения модели. Доказательством изоляции служит тест из шага 5.

## Что **не** входит в этап 1 (намеренно)
`/mode`, local-режим, ferrum-policy, подтверждения через кнопки, аудит, лимиты шагов и токенов (этап 2); браузер и веб (3); память и навыки (4); Google и Discord (5); cron и автозапуск (6).
