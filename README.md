<p align="center">
  <img src="assets/logo-128.png" width="96" height="96" alt="seo-tools-mcp" />
</p>

# seo-tools-mcp

[![CI](https://github.com/antohins/seo-tools-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/antohins/seo-tools-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Русский** | [English](README.en.md)

Шесть **универсальных** stdio MCP-серверов для SEO: доступ к SERP, Wordstat, Google Search Console, Яндекс.Вебмастеру и Яндекс.Метрике прямо из Claude Code (и любого MCP-клиента). Все инструменты **read-only**, вывод — строгий JSON. К конкретному сайту не привязаны: дефолты (свойство GSC, хост Вебмастера, счётчик Метрики) настраиваются на лету.

> 🛰 Эти серверы мы используем в продакшене в **[Satellite1](https://pbn-workers.com/ru/tools/seo-tools-mcp/)** — инфраструктура поискового топа: семантика, PBN и сателлиты, автоматизация SEO. Нужен стабильный органический трафик — [приходите](https://pbn-workers.com/ru/tools/seo-tools-mcp/).

| Сервер | Рабочие инструменты | Авторизация |
|---|---|---|
| `xmlstock` | `xmlstock_serp`, `xmlstock_images`, `xmlstock_news`, `xmlstock_video`, `xmlstock_balance` | API-ключ |
| `xmlriver` | `xmlriver_serp`, `xmlriver_images`, `xmlriver_news`, `xmlriver_check_index`, `xmlriver_balance` | API-ключ |
| `wordstat` | `wordstat_frequency`, `wordstat_dynamics`, `wordstat_regions`, `wordstat_regions_tree` | Api-Key Yandex Cloud |
| `gsc` | `gsc_query`, `gsc_inspect_url`, `gsc_list_sites`, `gsc_get_site`, `gsc_list_sitemaps`, `gsc_get_sitemap` | OAuth (все свойства аккаунта) / service account |
| `ywm` | `ywm_hosts`, `ywm_summary`, `ywm_search_queries`, `ywm_queries_history`, `ywm_recommended_queries`, `ywm_popular`, `ywm_indexing_history`, `ywm_sqi_history`, `ywm_external_links`, `ywm_broken_links`, `ywm_diagnostics`, `ywm_important_urls`, `ywm_sitemaps` | OAuth (авто-refresh) |
| `metrika` | `metrika_report`, `metrika_bytime`, `metrika_counters`, `metrika_goals`, `metrika_traffic_sources`, `metrika_geo`, `metrika_devices`, `metrika_landing_behavior`, `metrika_search_phrases`, `metrika_top_landings` | OAuth (авто-refresh) |

У каждого сервера дополнительно есть auth-инструменты `<server>_auth_status` и `<server>_set_credentials` (см. [Интерактивная авторизация](#интерактивная-авторизация-в-любой-сессии)).

## Инструменты по сервисам

### xmlstock — SERP Google/Яндекс
- `xmlstock_serp` — веб-выдача Google/Яндекса (органика + подсветки + SERP-фичи): регион, устройство, safe search, сортировка (Яндекс), период, рекламные блоки
- `xmlstock_images` — поиск картинок Google (url страницы + url изображения + заголовок)
- `xmlstock_news` — новости Google (заголовок, источник, дата, сниппет)
- `xmlstock_video` — видео Google (url, заголовок, превью, хост, канал, длительность)
- `xmlstock_balance` — баланс аккаунта / проверка ключа (бесплатно)

### xmlriver — SERP Google/Яндекс + проверка индексации
- `xmlriver_serp` — органика Google/Яндекса, глубина одним запросом (groupby до 100), флаг наличия AI Overview
- `xmlriver_images` — картинки Google (страница + url картинки + заголовок + источник + размеры)
- `xmlriver_news` — новости Google (заголовок, источник, дата, сниппет), фильтр по времени
- `xmlriver_check_index` — проверка индексации URL в Google/Яндексе (`inindex`)
- `xmlriver_balance` — баланс аккаунта / проверка ключа (бесплатно)

### wordstat — частотности Яндекса
- `wordstat_frequency` — широкая и точная частотность, уточняющие запросы (related) и ассоциации
- `wordstat_dynamics` — частотность по времени (день/неделя/месяц)
- `wordstat_regions` — распределение по регионам с индексом аффинити и именами регионов
- `wordstat_regions_tree` — полное дерево регионов Вордстата (id + имя)

### gsc — Google Search Console
- `gsc_query` — Search Analytics (клики/показы/CTR/позиция), авто-пагинация, `dataState` final/all
- `gsc_inspect_url` — URL Inspection: статус индексации, покрытие, canonical, последний обход, mobile usability, rich results
- `gsc_list_sites` — свойства, доступные авторизации
- `gsc_get_site` — уровень доступа к свойству
- `gsc_list_sitemaps` — отправленные sitemap со статусом
- `gsc_get_sitemap` — детали одного sitemap

### ywm — Яндекс.Вебмастер
- `ywm_hosts` — id пользователя + подтверждённые сайты
- `ywm_summary` — ИКС, страниц в поиске, исключено, проблемы сайта по важности
- `ywm_search_queries` — аналитика запросов по URL (~2 недели)
- `ywm_queries_history` — суммарные показы/клики/позиции по времени
- `ywm_recommended_queries` — приближённые рекомендованные запросы (спрос + недобор кликов)
- `ywm_popular` — популярные запросы хоста
- `ywm_indexing_history` — страниц в поиске по времени
- `ywm_sqi_history` — ИКС по времени
- `ywm_external_links` — выборка внешних ссылок + общее число
- `ywm_broken_links` — битые внутренние/внешние ссылки
- `ywm_diagnostics` — проблемы сайта
- `ywm_important_urls` — отслеживаемые URL со статусом индексации/поиска
- `ywm_sitemaps` — sitemap со статусом

### metrika — Яндекс.Метрика
- `metrika_report` — произвольный отчёт: любые dimensions × metrics, фильтры, сортировка (полный Stat API)
- `metrika_bytime` — метрики по времени (день/неделя/месяц/час)
- `metrika_traffic_sources` — визиты/пользователи/отказы по источникам трафика
- `metrika_geo` — визиты по стране/региону/городу
- `metrika_devices` — визиты по устройству/ОС/браузеру
- `metrika_goals` — список целей (конверсий)
- `metrika_counters` — доступные счётчики
- `metrika_landing_behavior` — поведение на посадочных + достижения целей
- `metrika_search_phrases` — поисковые фразы (органика)
- `metrika_top_landings` — топ органических посадочных

## Быстрый старт

### Вариант А — через npx (без клонирования)

Каждый сервер — самодостаточный npm-пакет `seo-tools-mcp-<сервер>`; ставится одной командой:

```bash
claude mcp add xmlstock --scope user -- npx -y seo-tools-mcp-xmlstock
claude mcp add xmlriver --scope user -- npx -y seo-tools-mcp-xmlriver
claude mcp add wordstat --scope user -- npx -y seo-tools-mcp-wordstat
claude mcp add gsc      --scope user -- npx -y seo-tools-mcp-gsc
claude mcp add ywm      --scope user -- npx -y seo-tools-mcp-ywm
claude mcp add metrika  --scope user -- npx -y seo-tools-mcp-metrika
```

### Вариант Б — из исходников

```bash
git clone https://github.com/antohins/seo-tools-mcp.git && cd seo-tools-mcp
pnpm install && pnpm build
ROOT=$(pwd)
for s in xmlstock xmlriver wordstat gsc ywm metrika; do
  claude mcp add "$s" --scope user -- node "$ROOT/servers/$s/dist/index.js"
done
```

Дальше (любой вариант) — **прямо в диалоге Claude Code**: «настрой доступ к xmlstock» → агент вызовет `xmlstock_auth_status`, подскажет, какие ключи нужны и где их взять, примет их через `xmlstock_set_credentials` и сохранит. После этого спрашивайте данные обычным языком: «сними топ-10 Яндекса по запросу X», «частотность фраз …», «клики/показы из GSC за месяц». Ключи и OAuth настраиваются один раз (см. [Получение доступов](#получение-доступов-по-сервису)).

## Интерактивная авторизация (в любой сессии)

У каждого сервера есть auth-инструменты — ключи можно выдавать прямо в диалоге, без правки файлов и перезапуска:

- `<server>_auth_status` — вызывается в начале работы: показывает, какие ключи заданы (маскированно), каких не хватает и как их получить (шаги регистрации).
- `<server>_set_credentials` — сохраняет переданные значения в `~/.config/seo-tools-mcp/.env` (права 600) и применяет сразу.
- `gsc_save_sa_json` — принимает содержимое JSON-ключа сервис-аккаунта, кладёт его в конфиг-директорию и возвращает email, который нужно добавить в GSC.
- `ywm_oauth_start` / `metrika_oauth_start` → ссылка авторизации Яндекса; пользователь открывает, разрешает, копирует код → `*_oauth_finish` обменивает код на access+refresh токены. Дальше токен **обновляется автоматически** при протухании (code flow, не implicit).

Типовой сценарий новой сессии: «настрой доступ к xmlstock» → агент вызывает `xmlstock_auth_status` → просит недостающие ключи → `xmlstock_set_credentials` → работает.

⚠ Ключи, переданные через чат, проходят через контекст модели. Для максимальной гигиены можно по-прежнему вписать их в `~/.config/seo-tools-mcp/.env` руками — серверы подхватят файл сами.

## Мультиаккаунт

Клиентские сайты раскиданы по разным аккаунтам Google/Яндекса — поддерживаются **именованные профили**:

- Каждый рабочий инструмент принимает опциональный параметр **`account`** («clientX», «agency»...). Без него используется основной профиль — обратная совместимость полная.
- Ключи профиля хранятся в том же конфиге с суффиксом: `GSC_REFRESH_TOKEN__clientX`, `YANDEX_OAUTH_TOKEN__clientX`, `XMLSTOCK_KEY__clientX`…
- Добавление профиля: `gsc_oauth_start(account="clientX")` → пользователь авторизуется под **другим** Google-аккаунтом → `gsc_oauth_finish(account="clientX")`. Аналогично `ywm_oauth_start/finish(account=...)` для Яндекса; API-ключи — `<server>_set_credentials(account="clientX", ...)`.
- **OAuth-приложения общие**: один Google-client и одно Яндекс-приложение обслуживают все профили (клиент создаётся один раз, авторизаций — сколько угодно). Per-account хранятся только токены; refresh обновляет токен своего профиля.
- Резолв строгий: `account="clientX"` без настроенных ключей → ошибка со списком настроенных профилей (никаких тихих фолбэков в чужой аккаунт). Дефолты (`GSC_SITE_URL__clientX`, `YWM_HOST_ID__clientX`, `METRIKA_COUNTER_ID__clientX`) — тоже per-account.
- `<server>_auth_status` показывает все профили и их ключи (маскированно).
- Альтернатива для жёсткой изоляции: отдельный env-файл через `SEO_TOOLS_MCP_ENV` (при заданном пути домашний конфиг НЕ читается).

## Установка

```bash
cd seo-tools-mcp
pnpm install
pnpm build
```

## Секреты

Единый env-файл: `~/.config/seo-tools-mcp/.env` (права 600). Все серверы читают его при старте, а `*_set_credentials`/`*_oauth_finish` пишут в него сами — ручная правка не обязательна. Шаблон — [.env.example](.env.example). Переменные из окружения процесса имеют приоритет над файлом. Альтернативный путь к файлу — `SEO_TOOLS_MCP_ENV` (так один хост может держать несколько независимых профилей: разные `claude mcp add` с разным `SEO_TOOLS_MCP_ENV`).

## Регистрация в Claude Code

```bash
ROOT=/path/to/seo-tools-mcp
claude mcp add xmlstock --scope user -- node $ROOT/servers/xmlstock/dist/index.js
claude mcp add wordstat --scope user -- node $ROOT/servers/wordstat/dist/index.js
claude mcp add gsc      --scope user -- node $ROOT/servers/gsc/dist/index.js
claude mcp add ywm      --scope user -- node $ROOT/servers/ywm/dist/index.js
claude mcp add metrika  --scope user -- node $ROOT/servers/metrika/dist/index.js
```

`--scope user` — доступно во всех сессиях/проектах. Для шаринга на команду — `--scope project` (создаст `.mcp.json` в репозитории; секреты подставлять только через `${VAR}`).

## Получение доступов (по сервису)

> Всё из этого раздела продублировано в ответах `<server>_auth_status` — агент сам подскажет шаги. Ниже — для чтения человеком.

### XMLStock (приоритет 1) — SERP Google + Яндекс

1. Регистрация: https://xmlstock.com → личный кабинет, пополнить баланс (Google XML и Яндекс Live — от 12 ₽/1000 запросов).
2. Взять ID пользователя и API-ключ → `XMLSTOCK_USER`, `XMLSTOCK_KEY` (или через `xmlstock_set_credentials`).
3. Проверка: `xmlstock_balance`.

Нюансы (выяснено на живых ответах):
- подсветки выдачи (`text_bolds`) — параметр `hlword=1`, тег `<hlword>` вложенным XML (парсится через stopNodes, соседние слова склеиваются во фразы); PAA и related searches — `related=1` (PAA только у Google);
- **mobile-выдача не отдаёт hlword/PAA/related** — мобильный слепок только позиции+сниппеты, подсветки снимать с desktop;
- страницы с 0 у обоих движков; органики на странице бывает <10 — сервер сам добирает страницей (+1 платный запрос);
- `lr` принимает id регионов Яндекса для обоих движков (XMLStock маппит на Google сам);
- ошибки HTTP 200 + `<error code>`: 20–25/101/110/111/500 ретраятся, 55 — rate-limit с паузой, 15 = пустая выдача (деньги списаны), 31/42 — фатальные (авторизация);
- **Wordstat у XMLStock НЕТ** — частотности через отдельный сервер (официальный API Вордстата Яндекса).

### Wordstat (приоритет 1) — частотности Яндекса

Официальный **Wordstat API v2** (в составе Yandex Cloud Search API) — бесплатный, без заявок и OAuth. Один раз в https://console.yandex.cloud:

1. Создать каталог (folder) или взять существующий → его ID в `WORDSTAT_FOLDER_ID`.
2. Создать сервисный аккаунт с ролью **`search-api.webSearch.user`**.
3. Выпустить для него **API-ключ** с областью действия **`yc.search-api.execute`** → `WORDSTAT_API_KEY`.
4. Проверка: `wordstat_frequency` по любой фразе.

Нюансы: точная частотность = операторы `"!слово !слово"` (поддерживаются в topRequests/regions; в dynamics — только при period=daily); данные topRequests — за последние 30 дней; `count` приходит строками (парсится); квоты **10 rps / 100 запросов в час** (429 ретраится, но для массового съёма закладывать троттлинг); associations максимум 20.

### Google Search Console (приоритет 1)

Два пути; **рекомендуемый — OAuth**: токен наследует доступ твоего Google-аккаунта и видит **все его свойства GSC разом** (включая будущие), добавлять пользователя в каждое свойство не нужно.

**Путь A — OAuth (один раз):**

1. https://console.cloud.google.com → проект → APIs & Services → Library → включить **Google Search Console API**.
2. **OAuth consent screen**: тип External; себя — в Test users. (Для refresh-токена дольше 7 дней — нажать **Publish app**; предупреждение «unverified» при авторизации — норма для личного использования.)
3. **Credentials → Create credentials → OAuth client ID → Desktop app** → взять client ID + secret.
4. В чате: `gsc_oauth_start` (передать clientId+secret) → открыть ссылку → разрешить → браузер редиректнется на `localhost:8585`, код подхватится автоматически → `gsc_oauth_finish`.
5. Проверка: `gsc_list_sites` — покажет все свойства аккаунта.

**Путь B — сервис-аккаунт (для headless-кронов):** IAM → Service Accounts → JSON-ключ → `gsc_save_sa_json` (или путь в `GSC_SA_JSON`) → добавить email аккаунта в **каждое** нужное свойство GSC (Настройки → Пользователи и права, «Полный»).

Если заданы оба — приоритет у OAuth.

### Яндекс OAuth (Вебмастер + Метрика — одно приложение, один токен)

1. Один раз: https://oauth.yandex.ru/client/new → «Веб-сервисы», Redirect URI: `https://oauth.yandex.ru/verification_code`. Права (scope): **Яндекс.Вебмастер** — «Получение информации о сайтах» (`webmaster:hostinfo`) + «Управление сайтами» (`webmaster:verify`); **Яндекс.Метрика** — «Получение статистики» (`metrika:read`). Взять ClientID и Client secret.
2. Дальше — интерактивно в чате: `ywm_oauth_start` (передать ClientID + secret, сохранятся) → открыть ссылку под аккаунтом-владельцем сайта/счётчика → скопировать код → `ywm_oauth_finish`. Получатся access+refresh токены, общие для ywm и metrika; **обновляются автоматически**.
3. Дефолты: `YWM_HOST_ID` (список — `ywm_hosts`), `METRIKA_COUNTER_ID` (список — `metrika_counters`) — задать через `*_set_credentials`, либо передавать в каждом вызове.
4. Ручная альтернатива: получить токен implicit-flow (`response_type=token`) и сохранить в `YANDEX_OAUTH_TOKEN` — но без refresh он протухнет (Вебмастер ~6 мес, Метрика ~1 год).

Ограничения API Яндекса (не баги серверов): фильтр по URL в Вебмастере есть только в query-analytics (данные ~2 недели); эндпоинта «рекомендованные запросы» в API v4 нет — `ywm_recommended_queries` аппроксимирует через спрос (DEMAND) + недобор кликов; поисковые фразы в Метрике в основном «Не определено» (шифрование).

## Формат дат и регионы

Даты — `YYYY-MM-DD` (МСК). Регионы (в `xmlstock_serp`, Wordstat и др.): имя из встроенного списка частых регионов («Москва», «спб», «Казахстан»…), несколько через запятую, **или** числовой id региона Яндекса (`213`, `225`…) — числовой id работает всегда. Полный справочник id — инструмент `wordstat_regions_tree`.

## Где и как использовать

Серверы — обычные stdio-процессы без привязки к машине. Четыре сценария:

### 1. Claude Code, локально

Зарегистрировать через `claude mcp add --scope user` (блок «Регистрация в Claude Code» выше) — доступно во всех проектах и сессиях.

### 2. Claude Code, другая машина

```bash
git clone https://github.com/antohins/seo-tools-mcp.git && cd seo-tools-mcp
pnpm install && pnpm build
# зарегистрировать серверы (блок «Регистрация в Claude Code» выше)
# ключи: скопировать ~/.config/seo-tools-mcp/.env со старой машины (chmod 600)
# ЛИБО выдать в диалоге через <server>_auth_status → <server>_set_credentials
```

### 3. Claude Desktop (локально)

В `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`):

```json
{
  "mcpServers": {
    "xmlstock": { "command": "node", "args": ["/ABS/PATH/seo-tools-mcp/servers/xmlstock/dist/index.js"] },
    "wordstat": { "command": "node", "args": ["/ABS/PATH/seo-tools-mcp/servers/wordstat/dist/index.js"] }
  }
}
```

Ключи подхватятся из `~/.config/seo-tools-mcp/.env` автоматически.

### 4. Удалённо: claude.ai / Claude Code с любого места

claude.ai (web/mobile) умеет только **remote MCP** (Streamable HTTP по публичному HTTPS). Наши stdio-серверы выносятся на VPS через мост [supergateway](https://github.com/supercorp-ai/supergateway):

```bash
# на сервере: клонировать/собрать как в сценарии 2, ключи в ~/.config/seo-tools-mcp/.env
npx -y supergateway --stateful --outputTransport streamableHttp --port 8801 \
  --stdio "node /opt/seo-tools-mcp/servers/xmlstock/dist/index.js"   # и так для каждого сервера, порты 8801–8805
```

Дальше nginx: TLS + proxy_pass на `127.0.0.1:880X` под **секретным путём** (например `/mcp-<длинный-случайный-токен>/xmlstock/`) — supergateway слушать только на localhost. Подключение:

- **Claude Code**: `claude mcp add --transport http xmlstock https://host/<секретный-путь>/xmlstock/mcp`
- **claude.ai**: Settings → Connectors → Add custom connector → тот же URL.

⚠ Секретный путь — минимальный гейт (custom connectors claude.ai не передают произвольные заголовки авторизации). За эндпоинтом — все ключи сервисов, поэтому: только HTTPS, длинный токен в пути, отдельный access-лог.

Альтернатива для Claude Code без HTTP-моста — stdio через ssh:

```bash
claude mcp add xmlstock --scope user -- ssh root@SERVER node /opt/seo-tools-mcp/servers/xmlstock/dist/index.js
```

## Разработка

```bash
pnpm build        # собрать все воркспейсы
pnpm typecheck    # только типы
pnpm test         # юнит-тесты (vitest, без сети)
pnpm test:live    # лайв-смоук по реальным API (нужны креды в конфиге; free-эндпоинты)
node servers/xmlstock/dist/index.js   # ручной запуск (stdio)
```

Юнит-тесты покрывают чистую логику: маскирование секретов, классификацию OAuth-ошибок, пагинацию Метрики/GSC (дедуп, `truncated`), фильтры, парсер SERP, регионы. Лайв-смоук поднимает каждый сервер и дёргает бесплатный инструмент (`xmlstock_balance`, `wordstat_frequency`, `gsc_list_sites`, `ywm_hosts`, `metrika_counters`) — проверка авторизации end-to-end.

Общий код (`shared/`): HTTP-клиент с ретраями на 429/5xx (3 попытки, экспоненциальный backoff, Retry-After), загрузчик env + персистентный конфиг, фабрика auth-инструментов, Яндекс-OAuth с авто-refresh, JSON-хелперы MCP, счётчик расхода платных вызовов. XMLStock дополнительно ретраит свои «временные» коды из тела XML, код 15 («ничего не найдено») трактуется как пустая выдача.

Сборка серверов — `tsup`: `shared/` вбивается в единый `dist/index.js` каждого сервера (рантайм-зависимости остаются external), поэтому npm-пакет самодостаточен.

## Публикация в npm (мейнтейнерам)

Каждый сервер публикуется как отдельный пакет `seo-tools-mcp-<сервер>`; `shared/` приватный и в npm не уходит (вбит в серверы). Версии всех серверов держим синхронно.

```bash
npm login
pnpm -r build                 # shared (tsc) → серверы (tsup-бандл)
pnpm -r publish --access public   # публикует 5 серверов; private-пакеты (shared, корень) пропускаются
```

`pnpm publish` сам подставляет реальные версии вместо `workspace:*` и не даст опубликовать при грязном рабочем дереве. Бамп версии — `pnpm -r exec npm version patch` (или вручную в каждом `package.json`).

## Контрибьютинг

PR приветствуются — см. [CONTRIBUTING.md](CONTRIBUTING.md). История изменений — [CHANGELOG.md](CHANGELOG.md). Уязвимости — приватно через [Security Advisories](https://github.com/antohins/seo-tools-mcp/security/advisories/new) (детали — [SECURITY.md](SECURITY.md)).

## Лицензия

[MIT](LICENSE) © antohins
