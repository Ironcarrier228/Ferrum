# Лицензия OpenClaw

Проверено: 2026-10-01. Версия, на которую закреплён Ferrum: **openclaw 2026.9.7** (точная, без `^`).

## Итог

| Что | Значение |
| --- | --- |
| Лицензия OpenClaw | **MIT** |
| Правообладатель | Copyright (c) 2026 OpenClaw Foundation |
| Где подтверждено | поле `license` в `package.json` пакета, файл `LICENSE` в пакете и в корне репозитория `openclaw/openclaw` |
| Автоматическая проверка | `tests/contract/openclaw-assumptions.test.mjs`, тест `license:` (упадёт, если лицензия поменяется при обновлении версии) |
| Сторонний код внутри OpenClaw | `THIRD_PARTY_NOTICES.md` пакета: фрагменты Pi / pi-mono (MIT, Copyright (c) 2025 Mario Zechner) |

MIT разрешает использовать, копировать, изменять, объединять, публиковать, распространять и продавать программу при условии сохранить уведомление об авторских правах и текст лицензии во всех копиях или существенных частях. Гарантий нет («AS IS»).

## Что это значит для Ferrum

- Ferrum ставит OpenClaw как зависимость из npm и не копирует его код, поэтому отдельных обязательств сверх MIT не возникает. Текст лицензии лежит в `node_modules/openclaw/LICENSE` и сохраняется при установке.
- Если когда-нибудь понадобится форк с правками ядра (по условиям задачи только после согласования с тобой), в форке нужно оставить `LICENSE` и `THIRD_PARTY_NOTICES.md` без изменений.
- Лицензия самого Ferrum: **GNU GPL v3 или новее** (`GPL-3.0-or-later`, файл `LICENSE` в корне). Совместимость: MIT, BSD, ISC и Apache-2.0 (для GPLv3) совместимы с GPLv3. MPL-2.0 допускает объединение с GPL по пункту о «вторичных лицензиях», если файл не помечен как несовместимый. Artistic-2.0 тоже совместим. Ferrum не копирует код OpenClaw, а ставит его как зависимость и грузит свои плагины в его процесс, поэтому они остаются под GPL, а OpenClaw под MIT. Если решишь выложить Ferrum публично, исходники плагинов надо отдавать под GPL. Если вместо «или новее» нужен строго GPL-3.0-only, это меняется одной строкой в `package.json`.

## Лицензии транзитивных зависимостей

Скрипт `scripts/license-scan.mjs` читает поле `license` у каждого каталога пакета в `node_modules` (вместе с вложенными копиями, поэтому 491 каталог, а не 345 уникальных пакетов из lock-файла):

| Лицензия | Каталогов |
| --- | --- |
| MIT | 298 |
| ISC | 98 |
| Apache-2.0 (+1 записан как `Apache 2.0`) | 24 (+1) |
| BSD-2-Clause / BSD-3-Clause | 20 / 18 |
| BlueOak-1.0.0 | 17 |
| MPL-2.0 | 5 |
| `MIT OR Apache` / `MIT AND MPL-2.0` | 2 / 1 |
| Unlicense, 0BSD, CC0-1.0, CC-BY-3.0 (данные `spdx-*`), Artistic-2.0, `MIT OR GPL-3.0-or-later`, `MIT AND Zlib` | по 1 |

Отдельно отмечено (не блокирует использование, но стоит знать):

- **MPL-2.0** (5 каталогов: `@ubjs/core`, `@ubjs/node`, два платформенных `@ubjs/node-linux-x64-*`, `web-push`) и один `MIT AND MPL-2.0` (`@trycua/cua-driver-linux-x64-gnu`). Копилефт на уровне файлов: действует, только если менять сами эти файлы. Мы их не меняем.
- **`jszip`: `MIT OR GPL-3.0-or-later`**: двойная лицензия, выбираем MIT.
- **`npm`: Artistic-2.0**: сам менеджер пакетов входит в зависимости OpenClaw.
- **`spdx-exceptions`: CC-BY-3.0**: это справочные данные, не код.
- Сильного копилефта (GPL/AGPL без альтернативы) в дереве нет.

Повторить проверку после обновления версии OpenClaw:

```bash
node scripts/license-scan.mjs
```

## Полный текст лицензии OpenClaw

```
MIT License

Copyright (c) 2026 OpenClaw Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Third-party notices for incorporated or adapted code are recorded in
THIRD_PARTY_NOTICES.md.
```
