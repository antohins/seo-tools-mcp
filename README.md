<p align="center">
  <img src="assets/logo-128.png" width="96" height="96" alt="seo-tools-mcp" />
</p>

# seo-tools-mcp

[![CI](https://github.com/antohins/seo-tools-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/antohins/seo-tools-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Русский** | [English](README.en.md)

Восемь **универсальных** stdio MCP-серверов для SEO: доступ к SERP, Wordstat, Google Search Console, Google Analytics 4, Яндекс.Вебмастеру, Яндекс.Метрике и self-hosted A-Parser прямо из Claude Code (и любого MCP-клиента). Все инструменты **read-only**, вывод — строгий JSON. К конкретному сайту не привязаны: дефолты (свойство GSC, свойство GA4, хост Вебмастера, счётчик Метрики) настраиваются на лету.

> 🛰 Эти серверы мы используем в продакшене в **[PBN Workers](https://pbn-workers.com/ru/tools/seo-tools-mcp/)** — инфраструктура поискового топа: семантика, PBN и сателлиты, автоматизация SEO. Нужен стабильный органический трафик — [приходите](https://pbn-workers.com/ru/tools/seo-tools-mcp/).

| Сервер | Рабочие инструменты | Авторизация |
|---|---|---|
| `xmlstock` | `xmlstock_serp`, `xmlstock_images`, `xmlstock_news`, `xmlstock_video`, `xmlstock_wordstat`, `xmlstock_wordstat_dynamics`, `xmlstock_wordstat_regions`, `xmlstock_wordstat_regions_tree`, `xmlstock_balance` | API-ключ |
| `xmlriver` | `xmlriver_serp`, `xmlriver_images`, `xmlriver_news`, `xmlriver_maps`, `xmlriver_check_index`, `xmlriver_suggest`, `xmlriver_related_questions`, `xmlriver_balance` | API-ключ |
| `wordstat` | `wordstat_frequency`, `wordstat_dynamics`, `wordstat_regions`, `wordstat_regions_tree` | Api-Key Yandex Cloud |
| `gsc` | `gsc_query`, `gsc_inspect_url`, `gsc_list_sites`, `gsc_get_site`, `gsc_list_sitemaps`, `gsc_get_sitemap` | OAuth (все свойства аккаунта) / service account |
| `ga4` | `ga4_list_properties`, `ga4_metadata`, `ga4_check_compatibility`, `ga4_report`, `ga4_bytime`, `ga4_traffic_sources`, `ga4_geo`, `ga4_devices`, `ga4_top_pages`, `ga4_events`, `ga4_realtime` | OAuth (все свойства аккаунта) / service account |
| `ywm` | `ywm_hosts`, `ywm_summary`, `ywm_search_queries`, `ywm_queries_history`, `ywm_recommended_queries`, `ywm_popular`, `ywm_indexing_history`, `ywm_sqi_history`, `ywm_external_links`, `ywm_broken_links`, `ywm_diagnostics`, `ywm_important_urls`, `ywm_sitemaps` | OAuth (авто-refresh) |
| `metrika` | `metrika_report`, `metrika_bytime`, `metrika_counters`, `metrika_goals`, `metrika_traffic_sources`, `metrika_geo`, `metrika_devices`, `metrika_landing_behavior`, `metrika_search_phrases`, `metrika_top_landings` | OAuth (авто-refresh) |
| `aparser` | `aparser_ping`, `aparser_status`, `aparser_proxies`, `aparser_parsers`, `aparser_parser_fields`, `aparser_get_preset`, `aparser_serp_google`, `aparser_serp_yandex`, `aparser_suggest`, `aparser_request`, `aparser_bulk_request` | self-hosted A-Parser (URL + пароль API) |

У каждого сервера дополнительно есть auth-инструменты `<server>_auth_status` и `<server>_set_credentials` (см. [Интерактивная авторизация](#интерактивная-авторизация-в-любой-сессии)).

## Инструменты по сервисам

### xmlstock — SERP Google/Яндекс
- `xmlstock_serp` — веб-выдача Google/Яндекса (органика + подсветки + SERP-фичи): регион, устройство, safe search, сортировка (Яндекс), период, рекламные блоки; третий движок `yandex_xml` — официальный Яндекс XML (groupby до 100 за 1 запрос, hlword на любых устройствах, статистика found/found-docs; тариф от 24 ₽/1000)
- `xmlstock_images` — поиск картинок Google (url страницы + url изображения + заголовок)
- `xmlstock_news` — новости Google (заголовок, источник, дата, сниппет)
- `xmlstock_video` — видео Google (url, заголовок, превью, хост, канал, длительность)
- `xmlstock_wordstat` — Яндекс Wordstat: топ + похожие запросы с частотностью (можно по региону), операторы Wordstat
- `xmlstock_wordstat_dynamics` — динамика частотности по времени (день/неделя/месяц)
- `xmlstock_wordstat_regions` — спрос по регионам (count, share, affinity index + имена регионов)
- `xmlstock_wordstat_regions_tree` — дерево регионов Wordstat (id + имя + путь)
- `xmlstock_balance` — баланс аккаунта / проверка ключа (бесплатно)

> Wordstat через XMLStock — тем же ключом `XMLSTOCK_*`, что и SERP; **не нужен Yandex Cloud** (в отличие от отдельного сервера `wordstat`).

### xmlriver — SERP Google/Яндекс + проверка индексации
- `xmlriver_serp` — органика Google/Яндекса (глубина добирается пагинацией: каждые 10 позиций = 1 платный запрос), флаг наличия AI Overview; опция `includeAIOverview` — полный текст Обзора от ИИ + цитируемые ссылки (платный `ai=1`, только Google); `includeAdditional` — доп. SERP-блоки Google из `<addresults>` (knowledge_graph, localresultsplace, rs и др.; наполнение зависит от платных опций кабинета XMLRiver, непришедшие блоки — в `additional.unavailable`); гео-таргетинг Google — `location` (город → `loc`, «Moscow»/«1011969») и `country` (ISO/числовой id, автовыводится из города); `device` — desktop/mobile/tablet, `os` (ios/android) отправляется только при `device=mobile`
- `xmlriver_images` — картинки Google (страница + url картинки + заголовок + источник + размеры); гео — `location`/`country`
- `xmlriver_news` — новости Google (заголовок, источник, дата, сниппет), фильтр по времени; гео — `location`/`country`
- `xmlriver_maps` — поиск заведений по Google Maps (`setab=maps`, обязательные `zoom` 1–15 и `coords` «широта,долгота», `count` 5–50): название, рейтинг, адрес, телефон, сервисы, координаты, place_id, число отзывов. ВАЖНО: формат по доке, лайвом не подтверждён (на тестовом аккаунте эндпоинт устойчиво отвечает кодом 500 — вероятно, нужна платная опция кабинета)
- `xmlriver_check_index` — проверка индексации URL в Google/Яндексе (`inindex`)
- `xmlriver_suggest` — поисковые подсказки Google (до 50 фраз за вызов, платно за каждую фразу); гео подсказок — `location`/`country`
- `xmlriver_related_questions` — блок «Вопросы по теме» / People Also Ask Google (вопросы всегда; ответы — только при включённой платной опции «Related Questions с ответами» в кабинете)
- `xmlriver_balance` — баланс аккаунта / проверка ключа (бесплатно)

### wordstat — частотности Яндекса
- `wordstat_frequency` — широкая и точная частотность, уточняющие запросы (related) и ассоциации
- `wordstat_dynamics` — частотность по времени (день/неделя/месяц)
- `wordstat_regions` — распределение по регионам с индексом аффинити и именами регионов
- `wordstat_regions_tree` — полное дерево регионов Вордстата (id + имя)

### gsc — Google Search Console
- `gsc_query` — Search Analytics (клики/показы/CTR/позиция), авто-пагинация, `dataState` final/all, произвольные фильтры измерений (`filters`, AND-семантика) и `aggregationType` (auto/byProperty/byPage)
- `gsc_inspect_url` — URL Inspection: статус индексации, покрытие, canonical, последний обход, mobile usability, rich results
- `gsc_list_sites` — свойства, доступные авторизации
- `gsc_get_site` — уровень доступа к свойству
- `gsc_list_sitemaps` — отправленные sitemap со статусом
- `gsc_get_sitemap` — детали одного sitemap

Даты Search Analytics — по Pacific Time (не МСК); история ~16 месяцев; финальные данные отстают на ~2-3 дня (свежие — `dataState=all`); `ctr` в ответе — доля 0..1.

### ga4 — Google Analytics 4
- `ga4_list_properties` — свойства GA4, доступные авторизации (отсюда берётся `propertyId` — это **не** Measurement ID `G-XXXXXXX`)
- `ga4_metadata` — какие измерения и метрики доступны в ЭТОМ свойстве, включая кастомные (`customEvent:…`); поиск подстрокой, `blockedReasons` (по такой метрике отчёт вернёт нули) и `type` (целое/дробное для `metricFilters`)
- `ga4_check_compatibility` — совместима ли связка измерений/метрик в этом свойстве, без тяжёлого отчёта; при несовместимости — какие поля убрать
- `ga4_report` — произвольный отчёт: любые измерения × метрики, фильтры по измерениям, сортировка (полный Data API `runReport`)
- `ga4_bytime` — динамика метрик по времени (день/час/неделя/месяц)
- `ga4_traffic_sources` — источники трафика: группа каналов, source/medium, кампания; `organicOnly` — только органика
- `ga4_geo` — страна/регион/город
- `ga4_devices` — тип устройства/ОС/браузер
- `ga4_top_pages` — топ страниц по `pagePath`, странице входа или заголовку; фильтры `organicOnly` и `pathContains`
- `ga4_events` — события по `eventName`; `keyEventsOnly` — только ключевые события (бывшие конверсии)
- `ga4_realtime` — отчёт в реальном времени (последние 30 минут)

Единицы и даты: `bounceRate`/`engagementRate` GA4 отдаёт **долей 0..1** (не процентами); даты считаются в таймзоне **свойства** — принимаются `YYYY-MM-DD` и ключевые слова GA4 (`today`, `yesterday`, `28daysAgo`), фактическая таймзона возвращается в ответе. В ответах есть `totalRows`/`truncated`, а `thresholded: true` означает, что часть данных скрыта порогом конфиденциальности GA4.

### ywm — Яндекс.Вебмастер
- `ywm_hosts` — id пользователя + подтверждённые сайты
- `ywm_summary` — ИКС, страниц в поиске, исключено, проблемы сайта по важности
- `ywm_search_queries` — аналитика запросов по URL (~2 недели по умолчанию; переопределяется dateFrom/dateTo)
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

### aparser — мост к self-hosted A-Parser
- `aparser_ping` — проверка связи с инстансом и пароля API
- `aparser_status` — вердикт готовности: версия, установленные парсеры, очередь, живые прокси
- `aparser_proxies` — живые прокси инстанса (можно по пачкам proxy checkers; креды прокси не выводятся)
- `aparser_parsers` — парсеры, установленные на инстансе
- `aparser_parser_fields` — поля результата, которые умеет вернуть парсер (flat + arrays)
- `aparser_get_preset` — опции config-пресета парсера (чувствительные значения маскируются)
- `aparser_serp_google` — органика Google (парсер `SE::Google`); прокси по умолчанию + preflight живых прокси
- `aparser_serp_yandex` — органика Яндекса (`SE::Yandex`); регион через `lr`
- `aparser_suggest` — поисковые подсказки Google/Яндекса
- `aparser_request` — универсальный синхронный запрос к любому парсеру (`oneRequest`)
- `aparser_bulk_request` — пакетный запрос: один парсер, много запросов в N потоков (`bulkRequest`)

> Нужен **свой** запущенный инстанс [A-Parser](https://a-parser.com/?ref=38832) (лицензия + сервер): мост им управляет, но не хостит и не проксирует его. Прокси и прокси-чекеры (пачки) настраиваются один раз в GUI A-Parser — мост их читает, проверяет (preflight) и выбирает (`checkers`), но не создаёт. v1 синхронный и read-only: очередь задач и большие асинхронные выгрузки не подключены.

## Быстрый старт

### Вариант 1 — в один клик для Claude Desktop (.mcpb)

Самый простой способ, ничего ставить руками не нужно: скачай нужный `.mcpb` со [страницы релиза](https://github.com/antohins/seo-tools-mcp/releases/latest) и **открой двойным кликом** — Claude Desktop поставит сервер сам и спросит ключи в диалоге установки.

- Серверы с API-ключом (`xmlstock`, `xmlriver`, `wordstat`, `aparser`) — ключи вводятся прямо в установщике.
- Серверы на OAuth (`gsc`, `ga4`, `ywm`, `metrika`) ничего не спрашивают: авторизация проходит в чате (`<server>_oauth_start` → `<server>_oauth_finish`).

Бандлы самодостаточны (~0.2 МБ, зависимости внутри), Node.js 20+ нужен только для варианта с npx. Собрать самому: `pnpm build:mcpb`.

### Вариант 2 — плагин для Claude Code (маркетплейс)

Аналог `.mcpb`, но для Claude Code: сервер, ключи и подсказки ставятся одной командой, ключи спрашиваются диалогом, секреты уходят в системное хранилище, а не в открытый файл.

```bash
claude plugin marketplace add antohins/seo-tools-mcp
```

Дальше — **только те источники, которые нужны**; каждый плагин тянет ровно один сервер:

```bash
claude plugin install xmlstock@seo-tools-mcp
claude plugin install gsc@seo-tools-mcp
claude plugin install ga4@seo-tools-mcp
```

Доступны `xmlstock`, `xmlriver`, `wordstat`, `gsc`, `ga4`, `ywm`, `metrika`, `aparser` — и `seo-tools`, который ставит все восемь сразу. Бандл удобен, но это ~98 инструментов в каждой сессии: если работаешь только с Вебмастером и Метрикой, ставь два плагина, а не бандл.

Ключи можно ввести сразу (`--config KEY=VALUE`) или потом через `/plugin configure <плагин>@seo-tools-mcp`:

```bash
claude plugin install xmlstock@seo-tools-mcp --config XMLSTOCK_USER=12345 --config XMLSTOCK_KEY=...
```

Поля, помеченные как секретные (API-ключи, OAuth-секреты), Claude Code кладёт в системное хранилище; в `settings.json` они не попадают. Плагины на OAuth (`gsc`, `ga4`, `ywm`, `metrika`) при установке спрашивают только client_id/secret — сам вход проходит в чате через `<сервер>_oauth_start` → `<сервер>_oauth_finish`.

### Вариант 3 — через npx (без клонирования)

Каждый сервер — самодостаточный npm-пакет `seo-tools-mcp-<сервер>`; ставится одной командой:

```bash
claude mcp add xmlstock --scope user -- npx -y seo-tools-mcp-xmlstock
claude mcp add xmlriver --scope user -- npx -y seo-tools-mcp-xmlriver
claude mcp add wordstat --scope user -- npx -y seo-tools-mcp-wordstat
claude mcp add gsc      --scope user -- npx -y seo-tools-mcp-gsc
claude mcp add ga4      --scope user -- npx -y seo-tools-mcp-ga4
claude mcp add ywm      --scope user -- npx -y seo-tools-mcp-ywm
claude mcp add metrika  --scope user -- npx -y seo-tools-mcp-metrika
claude mcp add aparser  --scope user -- npx -y seo-tools-mcp-aparser
```

#### Нужен только один сервер?

Серверы **не связаны** между собой: возьмите один пакет и игнорируйте остальные. Каждый самодостаточен — общий код `@seo-tools/shared` вшит в сборку, так что лишних зависимостей и «хвоста» монорепы не тянется. Достаточно установить нужный пакет с npm — там уже всё из коробки (`npx -y` скачает и запустит его сам):

| Пакет (npm) | Сервер |
|---|---|
| [`seo-tools-mcp-xmlstock`](https://www.npmjs.com/package/seo-tools-mcp-xmlstock) | SERP Google/Яндекс + Wordstat |
| [`seo-tools-mcp-xmlriver`](https://www.npmjs.com/package/seo-tools-mcp-xmlriver) | SERP Google/Яндекс + проверка индексации |
| [`seo-tools-mcp-wordstat`](https://www.npmjs.com/package/seo-tools-mcp-wordstat) | частотности Яндекса (Yandex Cloud) |
| [`seo-tools-mcp-gsc`](https://www.npmjs.com/package/seo-tools-mcp-gsc) | Google Search Console |
| [`seo-tools-mcp-ga4`](https://www.npmjs.com/package/seo-tools-mcp-ga4) | Google Analytics 4 |
| [`seo-tools-mcp-ywm`](https://www.npmjs.com/package/seo-tools-mcp-ywm) | Яндекс.Вебмастер |
| [`seo-tools-mcp-metrika`](https://www.npmjs.com/package/seo-tools-mcp-metrika) | Яндекс.Метрика |
| [`seo-tools-mcp-aparser`](https://www.npmjs.com/package/seo-tools-mcp-aparser) | мост к self-hosted A-Parser |

```bash
# добавить один сервер в Claude Code
claude mcp add xmlstock --scope user -- npx -y seo-tools-mcp-xmlstock

# или запустить напрямую (ключи через env)
XMLSTOCK_USER=... XMLSTOCK_KEY=... npx -y seo-tools-mcp-xmlstock
```

В любом MCP-клиенте (Claude Desktop, Cursor…) — прописывается один блок в `mcpServers`:

```json
{
  "mcpServers": {
    "xmlstock": {
      "command": "npx",
      "args": ["-y", "seo-tools-mcp-xmlstock"],
      "env": { "XMLSTOCK_USER": "...", "XMLSTOCK_KEY": "..." }
    }
  }
}
```

> Прямая установка одного пакета по GitHub-ссылке (`npm i github:antohins/seo-tools-mcp`) **не поддерживается**: это pnpm-монорепа, отдельный подпакет так не ставится. Для установки из исходников — вариант Б ниже (клонировать + собрать). Готовые пакеты живут на npm.

### Вариант 4 — из исходников

```bash
git clone https://github.com/antohins/seo-tools-mcp.git && cd seo-tools-mcp
pnpm install && pnpm build
ROOT=$(pwd)
for s in xmlstock xmlriver wordstat gsc ga4 ywm metrika aparser; do
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
claude mcp add ga4      --scope user -- node $ROOT/servers/ga4/dist/index.js
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

### Google Analytics 4 (приоритет 1)

Авторизация та же, что у GSC, и **OAuth-приложение общее** (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` переиспользуются). Но scope у GA4 свой, поэтому нужна отдельная авторизация — один раз.

1. В том же проекте console.cloud.google.com → APIs & Services → Library → включить **Google Analytics Data API** и **Google Analytics Admin API**.
2. В чате: `ga4_oauth_start` (если client ID/secret уже сохранены для GSC — без аргументов) → открыть ссылку → разрешить → браузер редиректнется на `localhost:8586` (порт отличается от GSC, чтобы серверы не конфликтовали), код подхватится автоматически → `ga4_oauth_finish`.
3. Проверка: `ga4_list_properties` — покажет все свойства аккаунта и их `propertyId`.
4. Удобно сохранить свойство по умолчанию: `ga4_set_credentials` → `GA4_PROPERTY_ID` (числовой id из п. 3), иначе передавать `propertyId` в каждом вызове.

**Путь B — сервис-аккаунт:** JSON-ключ → `ga4_save_sa_json` → добавить email аккаунта в свойство GA4 (Администратор → Управление доступом к ресурсу, роль «Просмотр»).

### Яндекс OAuth (Вебмастер + Метрика — одно приложение, один токен)

1. Один раз: https://oauth.yandex.ru/client/new → «Веб-сервисы», Redirect URI: `https://oauth.yandex.ru/verification_code`. Права (scope): **Яндекс.Вебмастер** — «Получение информации о сайтах» (`webmaster:hostinfo`) + «Управление сайтами» (`webmaster:verify`); **Яндекс.Метрика** — «Получение статистики» (`metrika:read`). Взять ClientID и Client secret.
2. Дальше — интерактивно в чате: `ywm_oauth_start` (передать ClientID + secret, сохранятся) → открыть ссылку под аккаунтом-владельцем сайта/счётчика → скопировать код → `ywm_oauth_finish`. Получатся access+refresh токены, общие для ywm и metrika; **обновляются автоматически**.
3. Дефолты: `YWM_HOST_ID` (список — `ywm_hosts`), `METRIKA_COUNTER_ID` (список — `metrika_counters`) — задать через `*_set_credentials`, либо передавать в каждом вызове.
4. Ручная альтернатива: получить токен implicit-flow (`response_type=token`) и сохранить в `YANDEX_OAUTH_TOKEN` — но без refresh он протухнет (Вебмастер ~6 мес, Метрика ~1 год).

Ограничения API Яндекса (не баги серверов): фильтр по URL в Вебмастере есть только в query-analytics (данные ~2 недели); эндпоинта «рекомендованные запросы» в API v4 нет — `ywm_recommended_queries` аппроксимирует через спрос (DEMAND) + недобор кликов; поисковые фразы в Метрике в основном «Не определено» (шифрование).

### A-Parser (self-hosted) — SERP и сотни парсеров через свою коробку

1. Свой запущенный инстанс [A-Parser](https://a-parser.com/?ref=38832) (лицензия + сервер) — мост им управляет, но не хостит и не проксирует его.
2. В A-Parser: **Settings → API** — включить API-сервер, запомнить порт (обычно 9091) и пароль.
3. `APARSER_URL` = `http://<IP-инстанса>:<порт>/API` (обязательно с путём `/API`), `APARSER_PASSWORD` = пароль оттуда же → `aparser_set_credentials`.
4. Проверка: `aparser_ping`, затем `aparser_status` (готовность инстанса + живые прокси).

Нюансы: прокси и прокси-чекеры (пачки) настраиваются один раз в GUI — без живых прокси Google/Яндекс быстро банят, поэтому serp/suggest-инструменты делают preflight и предупреждают (`use_proxy=false` — на свой риск); пресеты и пачки по умолчанию задаются env (`APARSER_GOOGLE_PRESET`, `APARSER_YANDEX_PRESET`, `APARSER_PROXY_CHECKERS`, `APARSER_USE_PROXY`); v1 синхронный и read-only — очередь задач и мутирующие методы API не подключены.

## Формат дат и регионы

Даты — `YYYY-MM-DD` (МСК). Регионы: имя из встроенного списка частых регионов («Москва», «спб», «Казахстан»…) **или** числовой id региона Яндекса (`213`, `225`…) — числовой id работает всегда. Несколько регионов через запятую поддерживает только сервер `wordstat`; SERP-инструменты `xmlstock_*`/`xmlriver_*` принимают ОДИН регион. Полный справочник id — инструмент `wordstat_regions_tree`.

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

Юнит-тесты покрывают чистую логику: маскирование секретов, классификацию OAuth-ошибок, пагинацию Метрики/GSC (дедуп, `truncated`), фильтры, парсер SERP, регионы. Лайв-смоук поднимает каждый сервер и дёргает бесплатный инструмент (`xmlstock_balance`, `xmlriver_balance`, `wordstat_frequency`, `gsc_list_sites`, `ywm_hosts`, `metrika_counters`, `aparser_ping`) — проверка авторизации end-to-end.

Общий код (`shared/`): HTTP-клиент с ретраями на 429/5xx (3 попытки, экспоненциальный backoff, Retry-After), загрузчик env + персистентный конфиг, фабрика auth-инструментов, Яндекс-OAuth с авто-refresh, JSON-хелперы MCP, счётчик расхода платных вызовов. XMLStock дополнительно ретраит свои «временные» коды из тела XML, код 15 («ничего не найдено») трактуется как пустая выдача.

Сборка серверов — `tsup`: `shared/` вбивается в единый `dist/index.js` каждого сервера (рантайм-зависимости остаются external), поэтому npm-пакет самодостаточен.

## Публикация в npm (мейнтейнерам)

Каждый сервер публикуется как отдельный пакет `seo-tools-mcp-<сервер>`; `shared/` приватный и в npm не уходит (вбит в серверы). Версии всех серверов держим синхронно.

```bash
npm login
pnpm -r build                 # shared (tsc) → серверы (tsup-бандл)
pnpm -r publish --access public   # публикует 8 серверов; private-пакеты (shared, корень) пропускаются
```

`pnpm publish` сам подставляет реальные версии вместо `workspace:*` и не даст опубликовать при грязном рабочем дереве. Бамп версии — `pnpm -r exec npm version patch` (или вручную в каждом `package.json`).

## Контрибьютинг

PR приветствуются — см. [CONTRIBUTING.md](CONTRIBUTING.md). История изменений — [CHANGELOG.md](CHANGELOG.md). Уязвимости — приватно через [Security Advisories](https://github.com/antohins/seo-tools-mcp/security/advisories/new) (детали — [SECURITY.md](SECURITY.md)).

## Лицензия

[MIT](LICENSE) © antohins
