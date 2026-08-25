# AGENTS.md

Файл для AI-агентов, работающих с этим репозиторием. Основная документация проекта —
[README.md](README.md) (русский) и [README.en.md](README.en.md) (английский); правила контрибуции —
[CONTRIBUTING.md](CONTRIBUTING.md). Язык проекта: документация и большинство комментариев — на русском.

## Обзор проекта

**seo-tools-mcp** — pnpm-монорепозиторий с семью самодостаточными **stdio MCP-серверами** для SEO
(Model Context Protocol, SDK `@modelcontextprotocol/sdk`). Все инструменты **read-only** по отношению
к провайдерам данных, вывод — строгий JSON. К конкретному сайту серверы не привязаны.

| Сервер (`servers/<name>`) | npm-пакет | Назначение | Авторизация |
|---|---|---|---|
| `xmlstock` | `seo-tools-mcp-xmlstock` | SERP Google/Яндекс (органика + подсветки + SERP-фичи) + Яндекс Wordstat | API-ключ `XMLSTOCK_USER`/`XMLSTOCK_KEY` |
| `xmlriver` | `seo-tools-mcp-xmlriver` | SERP Google/Яндекс + проверка индексации URL | API-ключ `XMLRIVER_*` |
| `wordstat` | `seo-tools-mcp-wordstat` | Частотности Яндекса (официальный Wordstat API v2, Yandex Cloud) | `WORDSTAT_API_KEY` + `WORDSTAT_FOLDER_ID` |
| `gsc` | `seo-tools-mcp-gsc` | Google Search Console (Search Analytics, URL Inspection, sitemaps) | OAuth (приоритет) / service account |
| `ywm` | `seo-tools-mcp-ywm` | Яндекс.Вебмастер (запросы, ИКС, индексация, ссылки, диагностика) | Яндекс OAuth с авто-refresh |
| `metrika` | `seo-tools-mcp-metrika` | Яндекс.Метрика (отчёты Stat API, источники, гео, устройства, цели) | Яндекс OAuth (общий токен с ywm) |
| `aparser` | `seo-tools-mcp-aparser` | Мост к self-hosted A-Parser через его HTTP API (SERP, suggests) | `APARSER_URL` + `APARSER_PASSWORD` |

Полный список инструментов каждого сервера — в таблицах README.md.

## Технологический стек

- **Node.js ≥ 20** (CI и `.nvmrc` — Node 22), **pnpm 10** (workspaces: `shared` + `servers/*`).
- **TypeScript** (strict, `target: ES2022`, `module/moduleResolution: NodeNext`) — базовый конфиг
  `tsconfig.base.json`, в каждом пакете свой `tsconfig.json`.
- **ESM везде** (`"type": "module"`): относительные импорты пишутся с расширением `.js`
  (`import ... from './parse.js'`), хотя файл — `.ts`.
- **zod** — схемы параметров инструментов; **fast-xml-parser** — XML-ответы XMLStock/XMLRiver.
- **tsup** — сборка серверов; **tsc** — сборка shared; **vitest** — тесты; **Biome 2.5** — линт и формат.

## Структура кода

- `shared/` — приватный пакет `@seo-tools/shared`, общий код всех серверов:
  - `src/http.ts` — HTTP-клиент `fetchText`/`fetchJson`: ретраи 429/5xx (3 попытки, экспоненциальный
    backoff с jitter, уважение `Retry-After`), таймаут на весь запрос включая чтение тела,
    `HttpError` с маскированным `url` (и немаскированным `rawUrl` — **не логировать**).
  - `src/config.ts` — env-конфиг: чтение `~/.config/seo-tools-mcp/.env`, маскирование
    (`maskSecret`, `maskUrl`), мультиаккаунт (`NAME__account`), запись через `saveEnvValues`.
  - `src/env.ts` — `loadSharedEnv`, `requireEnv` (строгий, без фолбэка между профилями), `envOr`
    (мягкий фолбэк — только для общих OAuth-приложений).
  - `src/auth-tools.ts` — фабрика `registerAuthTools`: у каждого сервера инструменты
    `<prefix>_auth_status` и `<prefix>_set_credentials`; общий zod-параметр `accountParam`.
  - `src/mcp.ts` — `jsonResult` (успех — строго JSON), `errorResult`, `safeHandler` (ловит
    исключения → структурная ошибка, процесс не падает).
  - `src/yandex-oauth.ts` — Яндекс OAuth code flow с авто-refresh токена.
  - `src/yandex-regions.ts` — `resolveRegionId`: имя региона («Москва», «спб»…) → id Яндекса.
  - `src/cost.ts` — `CostLogger`: счётчик платных вызовов и оценка расхода в stderr.
  - `src/serp/` — парсеры XML-выдачи (`parseXml`, `parseDocs`, `stripTags` и др.).
- `servers/<name>/` — один сервер на провайдера. Внутри:
  - `src/index.ts` — регистрация инструментов и запуск stdio-транспорта (**импорт `index.ts`
    поднимает сервер** — в тестах его не импортировать).
  - Чистая тестируемая логика — в отдельных модулях: `serp.ts` (HTTP-слой и хелперы выдачи
    xmlstock/xmlriver), `wordstat.ts` (xmlstock: wordstatGet/даты/кэш регионов; wordstat:
    HTTP-слой/валидация/кэш), `queries.ts` (ywm), `utils.ts` (metrika), `logic.ts` +
    `paginate.ts` + `loopback.ts` (gsc), `client.ts` + `parse.ts` (aparser), `verticals.ts`,
    `suggest.ts` + `related.ts` + `geo.ts` + `data.ts` + `additional.ts` (xmlriver),
    `filters.ts`, `regions.ts`. **Новую чистую логику класть в модуль, а не
    инлайнить в `index.ts`** — иначе её нельзя юнит-тестировать.
  - `Dockerfile` (сборка через `pnpm deploy`, production-образ) и `server.json` (манифест
    MCP-реестра, `mcpName: io.github.antohins/...` в package.json).
- `tests/` — юнит-тесты vitest, импортируют исходники напрямую (`../shared/src/http.js`,
  `../servers/<name>/src/...`); `tests/live/` — лайв-смоук по реальным API (opt-in);
  `tests/e2e/` — протокольный e2e поверх **собранных** `dist` (`pnpm test:e2e`,
  отдельный `vitest.e2e.config.ts`, из основного прогона исключён). Юнит-тесты
  поломку сборки не видят — в npm уезжает dist, поэтому список инструментов,
  `title` и аннотации проверяются именно там.
- `.claude-plugin/marketplace.json` + `plugins/<name>/` — маркетплейс плагинов Claude Code:
  девять плагинов (по одному на сервер + бандл `seo-tools`). У каждого
  `.claude-plugin/plugin.json` (метаданные + `userConfig` — ключи спрашиваются диалогом,
  секретные уходят в системное хранилище) и `.mcp.json` (сам сервер через npx).
  `mcpServers` держать в `.mcp.json`, а НЕ инлайном в манифесте: при инлайне
  `claude plugin details` рапортует «MCP servers (0)».
- `assets/` — логотипы; `.github/workflows/ci.yml` — CI; `glama.json` — каталог Glama;
  `.plugin/plugin.json` — манифест Open Plugins (другой формат, не путать с `.claude-plugin/`).

## Команды

```bash
pnpm install        # установка (CI: pnpm install --frozen-lockfile)
pnpm build          # сборка всех воркспейсов: shared (tsc) → серверы (tsup-бандл)
pnpm typecheck      # tsc --noEmit по всем воркспейсам
pnpm lint           # Biome check (линт + формат)
pnpm format         # Biome check --write (автофикс)
pnpm test           # юнит-тесты vitest (без сети)
pnpm test:e2e       # e2e по протоколу: собранные dist поднимаются как stdio-серверы (без сети)
pnpm test:live      # LIVE=1: лайв-смоук по реальным API (нужны креды; в CI не гоняется)
node servers/<name>/dist/index.js   # ручной запуск сервера (stdio)
```

Перед PR прогонять: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e`
(это же делает CI на Node 22; версия pnpm берётся из `packageManager`).
Порядок сборки важен: серверы зависят от `shared/dist`, `pnpm -r build` резолвит его сам.

## Соглашения по коду

- **Стиль (Biome)**: отступ 2 пробела, ширина строки 140, одинарные кавычки, точки с запятой,
  висячие запятые. Отключены: `noExplicitAny`, `noNonNullAssertion`, `useTemplate`,
  `noAssignInExpressions` — `any` и `!` допустимы, но без злоупотреблений.
- **Read-only by design**: серверы никогда не мутируют данные провайдеров (исключение — auth-записи
  в собственный конфиг). Мутирующие методы API не подключать (см. комментарий в `aparser`).
- **Вывод инструментов — строго JSON** через `jsonResult`; ошибки — через `safeHandler`/`errorResult`.
- **Комментарии на русском** — норма (кодовая база смешанная); шапки файлов `index.ts` содержат
  нюансы API провайдера — при изменении поведения обновлять их.
- **Конфиг читается лениво** через `getConfig` (а не кешируется в константе при старте), чтобы
  `*_set_credentials` применялся без перезапуска.
- Именование инструментов: `<сервер>_<действие>` snake_case (`xmlstock_serp`, `ywm_hosts`).
- Каждый рабочий инструмент принимает опциональный `account` (мультиаккаунт) — используй
  `accountParam` из shared.
- **Полярность `truncated` зафиксирована (API НЕ менять)**: у SERP-серверов (xmlstock/xmlriver)
  `truncated=true` значит «выдача кончилась раньше запрошенного depth»; у остальных серверов —
  «за ответом есть ещё данные» (упёрлись в limit/кап/дедлайн). Смысл поля всегда описывать
  в description инструмента.

## Секреты и безопасность

- Единый конфиг: `~/.config/seo-tools-mcp/.env` (права 600); альтернативный путь — `SEO_TOOLS_MCP_ENV`
  (тогда домашний конфиг не читается). Шаблон — `.env.example`. Реальные значения **никогда не
  коммитить**.
- Приоритет: реальное окружение процесса > env-файл. Файл — источник истины, читается свежим.
- **Никаких секретов в коде, логах и тестах**: URL маскируются перед логированием (`maskUrl`),
  ключи в статусах — `maskSecret`. `HttpError.rawUrl` не логировать.
- Мультиаккаунт: ключи профиля хранятся с суффиксом `__<account>` (`GSC_REFRESH_TOKEN__clientX`).
  Резолв строгий — `account` без настроенных ключей → ошибка со списком профилей, **никаких тихих
  фолбэков** в чужой аккаунт. Фолбэк `NAME__account → NAME` (`envOr`) — только для общих
  OAuth-приложений (`GOOGLE_CLIENT_*`, `YANDEX_CLIENT_*`).
- Платные API (XMLStock, XMLRiver): каждый вызов — деньги. Учитывать через `CostLogger`; XMLStock
  дополнительно ретраит «временные» коды ошибок из тела XML (20–25/101/110/111/500), код 15 —
  «пустая выдача» (деньги списаны, но не ошибка), 31/42 — фатальные.

## Тестирование

- Юнит-тесты (`tests/*.test.ts`) — **без сети**: сетевые вызовы мокаются (`vi.stubGlobal('fetch', …)`).
  Покрывают чистую логику: маскирование секретов, ретраи HTTP, пагинацию (дедуп, `truncated`),
  фильтры, парсеры SERP/XML, резолв регионов, классификацию OAuth-ошибок.
- Лайв-смоук (`tests/live/`, `pnpm test:live`) поднимает каждый сервер и дёргает бесплатный
  инструмент (`xmlstock_balance`, `xmlriver_balance`, `wordstat_frequency`, `gsc_list_sites`,
  `ywm_hosts`, `metrika_counters`, `aparser_ping` — нужен запущенный инстанс A-Parser) —
  end-to-end проверка авторизации. Нужны креды в конфиге; в CI не гоняется.
- При изменении поведения — добавить/обновить тесты; `pnpm test` должен оставаться зелёным.

## Сборка и публикация

- Сборка сервера — `tsup`: `@seo-tools/shared` (devDependency) **вбивается в единый
  `dist/index.js`** (ESM, target node20), рантайм-зависимости из `dependencies` остаются external —
  npm-пакет самодостаточен.
- Публикация (мейнтейнеры): каждый сервер — отдельный публичный npm-пакет `seo-tools-mcp-<name>`,
  `shared` приватный и в npm не уходит. Версии всех серверов держать синхронно (см. корневой package.json — единый источник правды).
  ```bash
  pnpm -r build
  pnpm -r publish --access public   # private-пакеты пропускаются
  ```
  `pnpm publish` подставляет реальные версии вместо `workspace:*` и не публикует при грязном дереве.
  Бамп: версию править в корневом `package.json`, затем `pnpm version:sync` — он разносит её
  по всем 42 местам (package.json и server.json серверов, литерал `new McpServer({ version })`,
  манифесты плагинов). `pnpm version:check` тот же прогон без записи, он же стоит в CI.
  Изменения фиксировать в `CHANGELOG.md` (Keep a Changelog).
- Прямая установка подпакета по GitHub-ссылке не поддерживается (pnpm-монорепа); дистрибуция —
  через npm (`npx -y seo-tools-mcp-<name>`).

## Нюансы API провайдеров (важно при доработках)

- **XMLStock**: страницы выдачи с 0 у обоих движков; подсветки `hlword=1` и PAA/related — только на
  desktop (mobile отдаёт только позиции+сниппеты); `lr` принимает id регионов Яндекса для обоих
  движков; ошибки приходят HTTP 200 с `<error code>` в теле.
  Третий движок `yandex_xml` (эндпоинт `/yandex/xml/`, официальный Яндекс XML, лайв 2026-08):
  `groupby` до 100 РАБОТАЕТ (до 100 результатов за 1 платный запрос, depth до 1000), hlword
  приходит нативно в title и passages на любых устройствах; `<found>` и `<found-docs>` — РАЗНЫЕ
  счётчики (в ответе `found` / `found_docs` / `found_human`, не путать), у документов есть
  `id`/`modtime`/`saved_copy_url`/`is_local`; `filter` — семейный фильтр strict/moderate/none
  (корректный дом для safeSearch), поддержаны `sortby` (rlv/tm) и `maxpassages`; SERP-фичей/packs
  нет — чистая органика; тариф дороже (от 24 ₽/1000) — отдельный CostLogger
  (`XMLSTOCK_YANDEX_XML_PRICE_PER_CALL`, дефолт 0.024).
- **XMLRiver**: `groupby` игнорируется (всегда 10/страницу) — глубина только пагинацией
  (`page`: Google с 1, Яндекс с 0), каждая страница — платный запрос; `<hlword>` не отдаёт
  (проверено лайвом); `inindex` работает и у Яндекса; `lr` шлём только Яндексу (у Google это код
  языка), `filter` Яндексу не шлём (это «скрывать похожие», не family-filter); код 500 ретраим
  5с/10с (4 подряд → 202, часовая блокировка), 31/42/45/200 — фатальные auth/баланс;
  `ai=1` — ПЛАТНЫЙ параметр (доп. тарификация, замедляет выдачу, только Google): в `<ai><answer>`
  приходит base64-кодированный HTML обзора (~200 КБ), ссылок отдельным элементом нет — извлекаются
  из HTML; шлём только по `includeAIOverview=true` и только на первой странице.
  Гео-таргетинг Google (`xmlriver_serp`/`xmlriver_suggest`, лайв 2026-08): `location` (город →
  `loc`, Google criteria ID — 1011969 Москва / 1012040 СПб дают разную выдачу) и `country`
  (числовой id страны, RU=2643); country автовыводится из города, явный перекрывает; Яндексу
  loc/country НЕ шлём. Резолв — `servers/xmlriver/src/geo.ts`: справочник `geo.csv` (~5 МБ,
  скачивается раз, дисковый кэш `~/.config/seo-tools-mcp/cache/`, TTL 7 дней, in-flight дедуп),
  маппинги стран/доменов — `data.ts` (COUNTRIES/DOMAINS, конвертированы из справочников
  countries.xlsx/domains.xlsx; JSON под NodeNext не импортируется без import attributes,
  поэтому данные в TS); `domain` для Google маппится в числовой id (ru → 143).
  Подсказки (`xmlriver_suggest`): POST `setab=tips` с JSON-телом `{"phrases":[...]}` (1–50 фраз),
  ответ — плоский `{"phrases":[...]}` (~10 на фразу в порядке входа), ПЛАТНО за каждую фразу;
  ошибки — HTTP 200 с JSON `{"code","error"}`. «Вопросы по теме» / PAA
  (`xmlriver_related_questions`): GET `setab=rq`, `count` ОБЯЗАТЕЛЕН (без него ошибка 15),
  макс. 50; `title`/`snippet`/`url` приходят пустыми, пока в кабинете не включена платная
  опция «Related Questions с ответами» (вопросы парсятся всегда) — пустые ответы помечаются
  `answers_available: false`; нет PAA-блока → код 15 (тарифицируется, `empty: true`).
  Доп. SERP-блоки Google (`xmlriver_serp`, `includeAdditional` → `additional=knowledge_graph,...`,
  лайв 2026-08): блоки приходят в `<response><addresults>`; наполнение зависит от платных опций
  кабинета XMLRiver («Платные дополнительные параметры») и наличия блока в выдаче — на тестовом
  аккаунте `knowledge_graph` пришёл с ПУСТЫМИ полями, `localresultsplace`/`rs`/`g_discuss`/
  `faqsnippet` не пришли вовсе; непришедшие перечисляются в `additional.unavailable`.
  Только engine=google, параметр шлётся на первой странице пагинации (как ai=1); парсинг —
  `servers/xmlriver/src/additional.ts` (KG — плоские поля + reviews/events + `<point lat lng>`,
  rs → relatedSearches, остальные блоки — флаг `{ present: true }`).
- **Wordstat (Yandex Cloud)**: квоты 10 rps / 100 запросов в час (429 ретраится); точная частота —
  операторы `"!слово !слово"`; данные — за последние 30 дней.
- **GSC**: приоритет OAuth над service account; OAuth-токен видит все свойства аккаунта.
  `gsc_query`: произвольные `filters` (dimensionFilterGroups, AND внутри группы) и `aggregationType`;
  contains/regex-операторы — только для query/page, для country/device/searchAppearance — только
  equals/notEquals (валидируется в `logic.ts` до запроса); сборка групп/тела — `buildFilterGroups`/
  `buildQueryBody` в `servers/gsc/src/logic.ts`.
- **Яндекс Вебмастер/Метрика**: одно OAuth-приложение и один токен на оба сервиса, авто-refresh;
  ограничения API (фильтр по URL только в query-analytics ~2 недели; «рекомендованных запросов» в
  API v4 нет — `ywm_recommended_queries` аппроксимирует) — не баги серверов.
- Даты везде `YYYY-MM-DD` (МСК).
