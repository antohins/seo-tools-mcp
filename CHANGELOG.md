# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Claude Code plugin marketplace** (`.claude-plugin/marketplace.json` + `plugins/`): nine plugins —
  one per server plus a `seo-tools` bundle — installable with
  `claude plugin marketplace add antohins/seo-tools-mcp` and
  `claude plugin install <name>@seo-tools-mcp`. One plugin pulls exactly one server, which is the
  point: the bundle is ~98 tools in every session, and most work needs two or three sources.
  Each plugin declares its keys as `userConfig`, so Claude Code asks for them in a dialog and puts
  the ones marked `sensitive` (API keys, OAuth secrets) into the OS keychain instead of a plaintext
  file — verified by installing all nine locally and confirming the secret never reaches
  `settings.json`. `mcpServers` lives in each plugin's `.mcp.json` rather than inline in the
  manifest: with the inline form the servers still start, but `claude plugin details` reports
  "MCP servers (0)" — a lie in the most visible place of the plugin catalogue.

## [1.7.0] — 2026-08-08

Post-release review of 1.6.0 (two passes) — fixes for the newly published `ga4` server and the
shared Google module — plus five additions to `ga4`. Several items change behavior that 1.6.0
already shipped. Everything here was verified against a live GA4 property, which is also where the
last two defects were caught (the 403 hint discarding Google's own explanation, and a flawed
first attempt at isolating incompatible fields).

### Added
- **ga4**: `ga4_metadata` — which dimensions and metrics exist **in this property** (Data API
  `getMetadata`), custom definitions included (`customEvent:…`). A property exposes hundreds of
  fields (375 dimensions / 119 metrics on a live account), so the list is searchable, capped and
  descriptions are opt-in. Each field carries `type` (int vs float — matters for `metricFilters`)
  and `blockedReasons`: a blocked metric silently returns **zeros** in reports and makes a metric
  filter fail with 400, which is invisible without this tool.
- **ga4**: `ga4_check_compatibility` — is a dimension/metric combination valid for this property,
  without paying for a heavy report. Note the API's actual contract: the call **fails** when the
  requested combination is incompatible (that verdict is surfaced as `compatible: false` plus the
  fields GA4 wants removed), and on success it lists what else *can be added*. Filters participate
  in compatibility, so the same `filters`/`metricFilters` can be passed in. This is the only
  reliable way to check property-dependent combinations — e.g. the Search Console metrics
  (`organicGoogleSearchClicks` and friends) exist in metadata but pair with **nothing** unless the
  property is linked to Search Console.
- **ga4**: period comparison in every report tool — `compareStartDate`/`compareEndDate` add a second
  date range, and rows gain a `dateRange` column valued `current`/`previous`. Because GA4's `limit`
  applies to the whole response rather than per period, a truncated comparison now returns an
  explicit note to raise the limit.
- **ga4**: `metricFilters` in `ga4_report` — filter by metric **values** (`sessions > 50`), several
  conditions ANDed; integers are sent as `int64Value`, fractions as `doubleValue`.
- **ga4**: `includeTotals` in every report tool — metric totals in a `totals` field (one row per
  period when comparing; the period label is preserved while GA4's `RESERVED_*` placeholders are dropped).

### Fixed
- **ga4** (wrong data, silent): `ga4_events(keyEventsOnly: true)` returned **all** events — the flag
  only added the `keyEvents` metric and applied no filter at all. Now it filters on the `isKeyEvent`
  dimension (renamed from `isConversionEvent` in the 2024-05-06 API changelog); an empty result also
  carries a `note` explaining that key events may simply not be marked up in GA4.
- **ga4**: `ga4_top_pages(groupBy: "landing")` used the deprecated `landingPage`, which since
  2023-05-14 returns the path **without** the query string — figures diverged from the GA4 UI.
  Switched to `landingPagePlusQueryString`.
- **ga4**: `pathContains` now filters on the grouping dimension (and on `pagePath` only for
  `groupBy: "title"`). Filtering landing pages by the event-scoped `pagePath` answered a different
  question — "landing pages of sessions that viewed /blog" instead of "landing pages under /blog".
- **ga4**: `orderBy` outside the requested `metrics`/`dimensions` now fails locally with a clear
  message instead of being sent as a dimension and coming back as an opaque API 400 (the Data API
  requires the sort field to be present in the request).
- **ga4**: `ga4_realtime` no longer reports `timeZone`/`currency`/`thresholded` — `runRealtimeReport`
  has no `metadata` block at all, so those were always null placeholders. The fields are now absent
  rather than fake (`rowCount` **is** present there, so `truncated` still works).
- **ga4**: `truncated` accounts for `offset` — on the last page of a paginated report it no longer
  reports a truncation that isn't there (which would make a client loop forever).
- **ga4**: `ga4_list_properties` walks `nextPageToken` (Admin API caps `pageSize` at 200), bounded by
  a 20-page guard and a 2-minute deadline, with retries limited so the call can't run for tens of minutes.
- **shared/google**: the loopback page shown in the browser after consent named `gsc_oauth_finish`
  even for other servers — GA4 users were sent to the wrong tool (or a nonexistent one). The prefix
  is now passed per server and is a **required** parameter, so a future Google server cannot silently
  inherit the wrong name.
- **shared/google**: `<prefix>_oauth_start` now warns when it replaces the shared
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (which would invalidate refresh tokens of the other Google
  server), and separately warns when those keys are overridden by the process environment, in which
  case the passed client would not take effect at all.
- **shared/google**: HTTP 429 is reported as an exhausted quota with a per-server hint instead of a raw
  `RESOURCE_EXHAUSTED`; 403/429 arriving from the retry **after** a 401 are now classified too, and a
  429 from the token-exchange endpoint is no longer misreported as the target API's quota.
- **gsc**: removed the `REDIRECT_URI` constant left dead by the shared-module refactor; restored the
  wording of the `*_oauth_start`/`*_oauth_finish` descriptions, which the parameterization had garbled.

### Changed
- **tests**: new `tests/google-fetch.test.ts` (403/429 classification, retry after 401, token-endpoint
  429 not mislabeled) plus coverage for the fixed `ga4` paths (orderBy validation, offset-aware
  `truncated`, realtime without metadata). 469 → 474 tests.

## [1.6.0] — 2026-08-07

### Added
- **New server `ga4`** — Google Analytics 4 via the Data API v1beta and Admin API (8th server).
  Tools: `ga4_list_properties` (Admin API `accountSummaries` — where `propertyId` comes from),
  `ga4_report` (arbitrary dimensions × metrics, dimension filters, sorting), `ga4_bytime`
  (date/hour/week/month), `ga4_traffic_sources` (channel / source-medium / campaign, `organicOnly`),
  `ga4_geo`, `ga4_devices`, `ga4_top_pages` (page / landing page / title, `organicOnly`,
  `pathContains`), `ga4_events` (`keyEventsOnly` for key events) and `ga4_realtime`.
  Config: `GA4_REFRESH_TOKEN` / `GA4_SA_JSON` / `GA4_PROPERTY_ID`; the OAuth app is **shared with
  gsc** (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`), GA4 only needs its own consent (different
  scope) and uses loopback port 8586 so both servers can run at once.
  Responses carry `totalRows`/`truncated`, the property `timeZone` and `thresholded` (GA4 privacy
  threshold). Dates accept `YYYY-MM-DD` and GA4 keywords (`today`/`yesterday`/`NdaysAgo`) — they
  resolve in the property's timezone, so no local "today" is computed. NOTE: GA4 returns
  `bounceRate`/`engagementRate` as a **0..1 fraction**, not a percent (documented in the tools).

### Changed
- **shared**: Google authorization extracted from `servers/gsc` into a reusable subpath
  `@seo-tools/shared/google` (`createGoogleAuth` — token cache per profile, in-flight refresh
  dedup, service-account JWT, 401 retry for the OAuth path only, 403 → domain hint;
  `registerGoogleOauthTools` — `<prefix>_oauth_start`/`_oauth_finish`/`_save_sa_json`;
  `loopback.ts` moved as-is). Like `./serp`, it is a **separate subpath** so that
  `google-auth-library` stays out of the non-Google server bundles (verified: 0 occurrences in
  xmlstock/xmlriver/wordstat/ywm/metrika/aparser). `servers/gsc/src/index.ts` shrank 644 → 323
  lines with no behavior change; `isInvalidGrant`/`saJsonFileName`/`saKeyErrorText` now live in
  shared and are covered by the new `tests/google-auth.test.ts`.
- **docs**: `.mcp.json` had been missing `aparser` since 1.4.0 — added, together with `ga4`;
  both READMEs, `.env.example` and the from-source/registration snippets now cover all 8 servers;
  the six older Dockerfiles copy `servers/ga4/package.json` (otherwise `--frozen-lockfile` fails).

## [1.5.1] — 2026-08-07

### Fixed
- **xmlstock** (billing): the `yandex_xml` engine no longer fires an extra paid page. The
  pagination loop stopped only on a zero-doc page, so any query whose result count was below the
  requested `depth` (common with `groupby=100`) spent one extra premium request that returned
  nothing. For `yandex_xml` a partial page (`docs < pageSize`) is now treated as the last page;
  live Google/Yandex engines keep the zero-doc stop (Google legitimately returns 9 on a full page).
- **xmlriver**: `xmlriver_serp` additional blocks (`includeAdditional`) now strip markup from
  stopNode fields (`title`/`question`) — e.g. `Cafe <b>Nero</b>` no longer leaks raw tags into the
  output; `additional.ts` now uses `stripTags` like `maps.ts` already did.
- **xmlriver**: `xmlriver_maps` no longer plots a coordinate-less place at `0,0`. `lat`/`lng` are
  now optional and omitted when the item has no valid coordinates (a title-only place keeps its
  title without fake Null-Island coordinates).
- **release**: the 1.5.0 release commit bumped `package.json` and the `McpServer` version literals
  but left `servers/*/server.json` (×7) and `.plugin/plugin.json` at 1.4.0, so the MCP Registry
  and the plugin channel never received 1.5.0. All channels are re-synchronized at 1.5.1; the
  registry goes straight to 1.5.1.

## [1.5.0] — 2026-08-07

### Added
- **gsc**: `gsc_query` gained arbitrary dimension filters (`filters` → `dimensionFilterGroups`,
  up to 25, AND semantics within the group; the legacy `page` parameter keeps working and is
  merged into the same group) and `aggregationType` (`auto`/`byProperty`/`byPage`; sent only
  when non-default). Dimension×operator compatibility is validated BEFORE the request with a
  clear error (per the official API docs, contains/regex operators apply to `query`/`page` only;
  `country`/`device`/`searchAppearance` accept only equals/notEquals). Filter group and request
  body assembly live in `servers/gsc/src/logic.ts` (`buildFilterGroups`, `buildQueryBody`).
- **xmlstock**: `xmlstock_serp` gained a third engine `yandex_xml` — the official Yandex XML API
  via XMLStock (`/yandex/xml/`, live-verified 2026-08). Unlike the live engines, `groupby` works
  (up to 100 results per single PAID request, `depth` up to 1000), `hlword` highlights are native
  (title and passages, any device), and the response carries the official "found" stats:
  `found` (`<found priority="all">`), `found_docs` (`<found-docs priority="all">` — a DIFFERENT
  counter, never mixed with `found`) and `found_human`; result docs gain optional
  `id`/`modtime`/`saved_copy_url`/`is_local`. `safeSearch` maps to the official family filter
  (`filter` strict/moderate/none), `sortby`/`maxpassages` are supported; SERP features/packs are
  absent (pure organic). Billed at a separate, higher rate (from 24 ₽/1000) via its own CostLogger
  (`XMLSTOCK_YANDEX_XML_PRICE_PER_CALL`, default 0.024). Parsing fields live in
  `shared/src/serp/parse.ts`, engine logic in `servers/xmlstock/src/serp.ts`.
- **xmlriver**: `xmlriver_serp` gained `includeAdditional` — extra Google SERP blocks via the
  `additional=` API parameter (Google only, sent on the first SERP page only, like `ai=1`).
  Blocks arrive inside `<response><addresults>` and are parsed into the response field
  `additional`: `knowledge_graph` (flat fields normalized to snake_case, `reviews`/`events`
  arrays, `coordinates` from `<point lat lng>`), `local_results` (`localresultsplace/item`
  cards), `related_searches` (`rs` → `relatedSearches/query/title`), `faq` (`faqsnippet`;
  structure per docs, not live-verified); other requested blocks are reported as
  `{ present: true }`. Block content depends on the PAID options enabled in the XMLRiver
  dashboard ("Платные дополнительные параметры") and on the block being present in the SERP —
  requested but missing blocks are listed in `additional.unavailable`, fully empty ones are
  marked `empty: true`. Parsing lives in `servers/xmlriver/src/additional.ts`.
- **xmlriver**: new tool `xmlriver_maps` — Google Maps place search via `setab=maps`
  (mandatory `zoom` 1–15 and `coords` "lat,lng" — validated by a zod regex; optional `count`
  5–50, default 20, and `region` → `lr`). Returns `{ places: [{ title, stars?, type?, address?,
  url?, phone?, review?, features? (from `possibility`), lat, lng, place_id?, reviews_count?,
  accessibility?, price? }], count, found, empty? }`; code 15 → `empty: true` (billed), same as
  the other tools. IMPORTANT: the response format follows the XMLRiver docs but is NOT
  live-verified — the endpoint steadily returns error code 500 on the test account (regular
  SERP works), so a paid dashboard option is likely required; parsing is strictly defensive.
  Pure parser `parseMaps` + `mapsCoordsSchema` live in `servers/xmlriver/src/maps.ts`.
- **xmlriver**: `xmlriver_images` and `xmlriver_news` gained the same Google geo-targeting as
  serp/suggest — `location` (city → `loc`) and `country` (ISO/numeric id, auto-derived from the
  city), resolved via `servers/xmlriver/src/geo.ts` (`resolveLocation`/`resolveCountry`,
  shared handler helper `resolveGeo`); the applied geo is echoed in the response `geo` field.
  Verticals are Google-only, so there is no engine gate.
- **xmlriver**: `device` enum extended with `tablet` (`xmlriver_serp`, `xmlriver_images`,
  `xmlriver_news`, `xmlriver_related_questions`) and a new `os` parameter (`ios`/`android`) —
  sent only when `device=mobile` (per the docs `os` works with mobile only; for other devices
  it is not sent, which is documented in the parameter description).

## [1.4.0] — 2026-08-04

### Added
- **New server `aparser`** — a bridge to a self-hosted [A-Parser](https://a-parser.com/?ref=38832) instance
  via its HTTP API (7th server). v1 is synchronous and read-only: `aparser_ping`, `aparser_status`
  (readiness verdict + live-proxy count), `aparser_proxies`, `aparser_parsers`,
  `aparser_parser_fields`, `aparser_get_preset`, `aparser_serp_google`, `aparser_serp_yandex`,
  `aparser_suggest`, `aparser_request` (universal `oneRequest` for any of ~150 parsers) and
  `aparser_bulk_request`. Proxy packs (proxy checkers) are read/verified/selected (never created);
  presets are first-class with env defaults; a live-proxy preflight guards SERP calls and a human
  diagnostic explains captcha/burned-proxy failures. Verified end-to-end against a live instance
  (A-Parser v1.2.3527). Config: `APARSER_URL` + `APARSER_PASSWORD` (no OAuth).

- **xmlriver**: Google geo-targeting for `xmlriver_serp` (google engine) and `xmlriver_suggest` —
  new `location` and `country` parameters. `location` (English city name, e.g. "Moscow", or a
  numeric Google criteria ID like "1011969") resolves to the `loc` API parameter via the XMLRiver
  `geo.csv` reference (~5 MB, downloaded once, disk cache under `~/.config/seo-tools-mcp/cache/`,
  7-day TTL, in-flight dedup; ambiguous names prefer a `country` match, otherwise first hit + a
  note). `country` (ISO code or numeric XMLRiver id, RU=2643) is auto-derived from the city and
  overridden by an explicit value; the applied geo is echoed in the response `geo` field.
  Yandex requests never receive `loc`/`country` (Yandex geo stays on `region`/`lr`).
  `searchDomain` for Google is now mapped to the numeric domain id (`ru` → 143) per the API
  docs, with a string passthrough fallback for unknown domains; reference tables live in
  `servers/xmlriver/src/data.ts` (184 countries, 199 domains).
- **xmlriver**: new `xmlriver_related_questions` tool — the Google "People Also Ask" block
  via `setab=rq` (PAID per request; `count` is a mandatory API parameter, 1–50).
  Returns `{ questions: [{ question, title?, snippet?, url? }], count, answers_available,
  empty?, note? }`. Questions are always parsed; `title`/`snippet`/`url` are empty unless the
  paid "Related Questions with answers" option is enabled in the XMLRiver dashboard —
  the response then carries `answers_available: false` and an explanatory note. A query
  without a PAA block (API code 15) is billed and reported as `{ questions: [], empty: true }`;
  optional `region` (`lr`) and `device` parameters.
- **xmlriver**: new `xmlriver_suggest` tool — Google search suggestions via `setab=tips`
  (POST `{"phrases":[...]}`, 1–50 phrases per call, PAID per phrase: N phrases = N charges).
  Returns `{ phrases: string[] (flat, in input-phrase order, ~10 tips per phrase),
  byPhrase: Record<phrase, string[]> | null (grouped by equal chunks when divisible,
  otherwise null + note), count, charged }`; optional `region` (`lr`). JSON API errors
  (`{"code","error"}`, e.g. code 3) and non-JSON responses throw without billing.
- **xmlriver**: `xmlriver_serp` gained `includeAIOverview` — the full AI Overview via the PAID
  `ai=1` parameter (Google only, sent on the first SERP page only): the base64-HTML `<answer>`
  is decoded into `ai_overview: { present, available, text?, links? }` (cited links extracted
  from the HTML, deduped, Google service domains filtered; "обзор недоступен" → `available: false`).
  NOTE: without `includeAIOverview` the `ai_overview` field changed shape from a bare boolean
  to `{ present: boolean }`.
- **docs**: `aparser` was missing from the root READMEs — added to the summary table, the
  tools sections and the "getting access" sections of `README.md`/`README.en.md` (self-hosted
  disclaimer, proxy model); `.env.example` shows the `APARSER_URL` format
  (`http://IP:9091/API`); the live smoke now includes `aparser_ping`.

### Fixed
- **xmlstock**: `includeSimilar` now sends `filter=0` (standard Google semantics for omitted/similar
  results) instead of `filter=1`.
- **xmlstock**: a non-XML/invalid response (e.g. an HTML error page) is no longer silently treated
  as a successful empty SERP — a clear error is thrown and the call is NOT counted as billed.
- **xmlstock**: `found` extraction prefers `priority="all"` (fallback — first element) and no longer
  turns a legitimate `0` into `null`; the duplicated inline copy in `xmlstock_serp` is removed.
- **xmlstock**: retry-exhaustion error now includes the last error code and message
  (`XMLStock error 55: … — исчерпаны ретраи (4 попытки)`).
- **xmlstock**: region-tree cache now deduplicates the in-flight promise — two parallel
  `xmlstock_wordstat_regions` calls on a cold cache cost one paid `regionsTree` request, not two.
- **xmlriver**: `found` extraction prefers `priority="all"` (fallback — first element) and no longer
  turns a legitimate `0` into `null`; the non-XML check is strengthened to `yandexsearch.response`
  (HTML error pages throw a clear error and are NOT billed).
- **xmlriver**: Yandex `safeSearch` no longer sends `filter=moderate/strict/none` (at XMLRiver the
  Yandex `filter` means "hide similar results", enabled by `filter=1`) — the parameter is not sent
  for `engine=yandex` at all; a Yandex region id (`lr`) is no longer sent for `engine=google`
  (for Google `lr` is a language code).
- **xmlriver**: `xmlriver_check_index` now supports Yandex (`engine` parameter, `inindex` verified
  live); `strict` is sent only when `strict=true`; query length is validated (≤ 1400 chars,
  otherwise API error 16).
- **xmlriver**: retry policy aligned with the API docs — code 500 is retried with 5 s/10 s pauses
  (2 retries: 4 consecutive 500s trigger code 202, an hour-long block); code 202 is reported as a
  fatal temporary block ("повторите позже"); auth/balance codes 31/42/45/200 point to
  `xmlriver_set_credentials`; code 55 removed (absent from the XMLRiver docs); retry-exhaustion
  errors carry the last code and message; unreachable dead code removed.
- **gsc** (security): path traversal in `gsc_save_sa_json` — the `account` parameter was inserted
  into the key-file path unvalidated (`../../tmp/x` could write outside the config dir); the
  account name is now validated (via `saJsonFileName`/`validateAccount`) before any file write.
- **gsc**: the OAuth loopback listener auto-close timer is now cancelled in `stopLoopback()` —
  a timer from a finished flow can no longer kill the listener of a newer flow.
- **gsc**: the refresh→access exchange deduplicates the in-flight promise per account (parallel
  calls share one token request); the 401 retry now applies only to the OAuth path (for a service
  account it is pointless — JWT caches the token itself — so SA 401 reports a clear error
  immediately); 403 is classified as "no access to the property" pointing to
  `gsc_list_sites`/`gsc_get_site` and the `sc-domain:` / URL-prefix-with-trailing-`/` formats.
- **gsc**: `gsc_oauth_start` with `account` no longer silently overwrites the base
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` — credentials are saved profile-suffixed
  (`GOOGLE_CLIENT_ID__<account>`), documented in the tool response; `gsc_oauth_finish` and
  `gsc_save_sa_json` warn when the key is overridden by the real process environment.
- **gsc**: `gsc_query` honestly reports the truncation reason (`truncatedBy: limit|deadline` —
  the 5-minute pagination deadline is no longer logged as "обрезано по rowLimit"), exposes
  `firstIncompleteDate` for `dataState=all`, validates `startDate <= endDate`, and its description
  documents Pacific Time dates, ~16 months of history, the ~2-3 day finalization lag and
  `ctr` being a 0..1 fraction; a broken `GSC_SA_JSON` path now yields a clear error pointing to
  `gsc_set_credentials`/`gsc_save_sa_json`; pure logic (resolveSite, date validation,
  invalid_grant classification, key mapping) moved to `src/logic.ts` and is unit-tested.
- **docker**: the six older server Dockerfiles (xmlstock, xmlriver, wordstat, gsc, ywm, metrika)
  now also copy `servers/aparser/package.json`, fixing the `pnpm install --frozen-lockfile`
  mismatch with the lockfile.
- **wordstat**: the region-tree cache now deduplicates the in-flight promise per account — two
  parallel `wordstat_regions` calls on a cold cache cost one `getRegionsTree` request, not two.
- **wordstat**: `wordstat_dynamics` validates dates before the request with clear messages:
  `fromDate <= toDate`; `monthly` requires `fromDate` = 1st of month and `toDate` = last day of
  month; `weekly` requires `fromDate` = Monday; `daily` is limited to the last 60 days.
- **wordstat**: error classification in the HTTP layer — 401/403 point to
  `WORDSTAT_API_KEY`/`WORDSTAT_FOLDER_ID` and the `search-api.webSearch.user` role; the final
  429 (after retries) mentions the 100 requests/hour quota.
- **shared**: user-facing error texts no longer contain the `<server>` placeholder —
  `getYandexToken`/`yandexFetchJson` accept an optional server prefix (`ywm`/`metrika`) and
  name real tools (`ywm_oauth_start`, `metrika_set_credentials`, …); `requireEnv` uses a
  neutral placeholder-free wording.
- **ywm**: `getUserId` validates the `/user/` response (non-numeric `user_id` → a clear error,
  never cached) and deduplicates the in-flight promise — two parallel calls on a cold cache
  cost one `/user/` request, not two.
- **ywm**: error classification in the HTTP layer — 403 points to host access / the Webmaster
  scope (`ywm_hosts`, `ywm_oauth_start`), 404 — to the `hostId` format (`https:example.com:443`);
  `resolveHost` validates the `hostId` format up front.
- **ywm**: date validation — `dateFrom <= dateTo` with a clear message in every dated tool;
  the default "today" is computed in Moscow time (UTC+3), matching Yandex's statistics timezone.
- **metrika**: `accuracy` is validated before the request (`low|medium|high|full` or a sample
  share in (0,1]) with a clear message; the description no longer lists the invalid `auto`.
- **metrika**: default dates ("today", the 30-day window) are computed in Moscow time (UTC+3),
  not UTC; `date1 <= date2` (`startDate <= endDate`) is validated in every dated tool.
- **metrika**: an unexpected Stat API response shape (`data` not an array) now throws a clear
  "неожиданный формат ответа Метрики" error instead of a bare TypeError (single page and
  paginated collection alike).
- **metrika**: the goals cache is keyed by `account + counterId` and deduplicates the in-flight
  promise — two parallel `metrika_landing_behavior` calls on a cold cache cost one goals request.
- **metrika**: a failed goals request in `metrika_landing_behavior` surfaces as
  `goals_loaded: false` + `goals_error: true` (previously only a stderr line); auto-clipping
  beyond 10 goals is flagged with `goals_truncated: true` + `goals_dropped`.
- **metrika**: 403/404 from the Stat/Management API are classified with actionable hints —
  no counter access / counter not found, pointing to `metrika_counters` and
  `METRIKA_COUNTER_ID` (`metrika_set_credentials`).
- **aparser**: a "success but no `results`" API response is no longer silently treated as a
  legitimate empty SERP — `aparser_serp_*`/`aparser_suggest`/`aparser_request` now return
  `results_present: false` + `note` (a broken response is distinguished from a legitimately
  empty result, which always has `results[0]` with an empty `serp`); SERP results also carry
  `empty: true` for a legitimate empty SERP and `success`/`diagnostic` are documented as the
  captcha/burned-proxy signal.
- **aparser**: `aparser_bulk_request` no longer distorts non-SERP results — `parseSerpResult`
  normalization applies only to `SE::Google`/`SE::Yandex`, other parsers' results are returned
  as-is; `count < requested` is flagged with a `note`; the heavy bulk call is made with
  `attempts: 1` (no retry doubling the instance load) and a documented 120 s single-shot timeout.
- **aparser** (security): `aparser_get_preset` masks option values whose keys match
  `pass|key|token|secret` (proxy credentials, parser API keys); the non-JSON error snippet
  is run through secret masking (`key=value` → `REDACTED`); `aparser_proxies` output is
  capped at 100 entries (`truncated: true`, full `count`).
- **aparser**: `aparser_suggest` now runs the same live-proxy preflight as the SERP tools;
  network-level failures point to `aparser_ping`/`aparser_set_credentials`; pure logic
  (`aparserCall`, `buildOverrides`, `resolveExec`, `ensureProxies`, preset masking) moved to
  `src/client.ts` and is unit-tested (`tests/aparser-client.test.ts`).
- **gsc**: reusing a live OAuth loopback listener now RE-ARMS its 10-minute auto-close timer —
  previously a timer from an abandoned flow (no `gsc_oauth_finish`) fired mid-flow and killed
  the listener of the next flow; the loopback logic moved to `servers/gsc/src/loopback.ts`
  and is unit-tested.
- **shared** (yandex-oauth): when the same token string was stored in both `YWM_OAUTH_TOKEN`/
  `METRIKA_OAUTH_TOKEN` and `YANDEX_OAUTH_TOKEN`, a refresh rewrote only the shared key — the
  next 401 then misread the specific key as a "foreign" token and refused to refresh; a refresh
  now rewrites BOTH keys when they were equal; the "refresh token was rejected" case (dead
  grant) is now reported as "грант отозван или протух — переавторизуйся" instead of
  "refresh-токена нет".
- **shared**: `maskSecretsInText` now also masks the JSON form (`"password":"secret"` →
  `"password":"REDACTED"`), not only `key=value` pairs.
- **xmlstock**: `xmlstock_wordstat_dynamics` validates `from <= to` before the paid request
  with a clear message.
- **aparser**: Biome `useOptionalChain` warnings cleaned up (`a && a.b` → `a?.b`) — `pnpm lint`
  is now warning-free.

### Changed
- **xmlriver**: `groupby` is silently ignored by the API (always 10 organic results per page,
  verified live) — `xmlriver_serp`/`_images`/`_news` now collect `depth` by pagination (`page`:
  Google from 1, Yandex from 0, stop at the first empty page, continuous `position` numbering);
  `groupby` is no longer sent. Each page is a separate paid request.
- **all servers**: the `McpServer({ version })` literal is synchronized with the package version
  (1.0.0 → 1.3.0); `AGENTS.md` now reminds maintainers to bump it on release.
- **xmlstock**: `xmlstock_serp` response gains `count` (like `xmlriver_serp`); the Wordstat HTTP
  layer (`wordstatGet`), date helpers (`wsDate`, `from <= to` validation in
  `xmlstock_wordstat_dynamics`) and the per-account region-names cache moved to
  `servers/xmlstock/src/wordstat.ts`; `verticalCommon` moved to `src/serp.ts`
  (`index.ts` is registration-only).
- **ywm**: `ywm_popular` pagination (short-page stop, `truncated` heuristic) moved to
  `servers/ywm/src/queries.ts`; the duplicated inline date schemas were replaced with the shared
  `dateFromParam`/`dateToParam`; date-order validation is now unconditional (a lone future
  `dateFrom` fails with a clear message); `truncated` is spelled out in the descriptions of
  `ywm_search_queries`/`ywm_recommended_queries`/`ywm_popular`.
- **wordstat**: the `daily` 60-day boundary in `wordstat_dynamics` is computed in Moscow time
  (UTC+3), matching Yandex's timezone; `wordstat_frequency` description spells out
  `related_truncated`.
- **server.json**: declared the previously missing optional env vars — gsc
  (`GSC_SA_JSON`, `GSC_OAUTH_PORT`), metrika (`METRIKA_OAUTH_TOKEN`, `YANDEX_CLIENT_ID`,
  `YANDEX_CLIENT_SECRET`), ywm (`YWM_USER_ID`), xmlstock/xmlriver (`*_EXCLUDE_DOMAINS`,
  `*_PRICE_PER_CALL`, `XMLSTOCK_WORDSTAT_PRICE_PER_CALL`), aparser (`APARSER_GOOGLE_PRESET`,
  `APARSER_YANDEX_PRESET`, `APARSER_PROXY_CHECKERS`, `APARSER_USE_PROXY`).
- **docs**: `AGENTS.md` documents the new per-server modules, the `truncated` polarity convention
  (SERP servers vs the rest) and the `McpServer` version bump; the smoke-tool lists in both
  READMEs include `xmlriver_balance`; `README.en.md` gains the GSC note (Pacific Time dates,
  ~16 months of history, ~2-3 day lag, `ctr` 0..1); `ywm_search_queries` entries mention
  `dateFrom`/`dateTo`.
- **tests**: new `tests/gsc-loopback.test.ts` (timer re-arm on listener reuse, `stopLoopback`
  clearing the timer), `tests/yandex-oauth-refresh.test.ts` (specific===general refresh
  synchronization, dead-grant vs missing-refresh wording), `tests/xmlstock-wordstat-get.test.ts`
  (`wordstatGet` auth classification 100/200, HTTP retries).
- **xmlstock**: SERP responses include `truncated` (true = the SERP ended before the requested
  `depth`); empty SERPs (code 15, still billed) are marked with `empty: true` + `note`.
- **xmlstock**: Wordstat spend is tracked separately via `XMLSTOCK_WORDSTAT_PRICE_PER_CALL`
  (default 0.019 ₽, vs `XMLSTOCK_PRICE_PER_CALL` for SERP).
- **xmlstock**: parameter validation tightened (`from`/`to` — `YYYY-MM-DD`, `searchDomain`, `lang`,
  `l10n` enum); descriptions clarified (single `region`, `safeSearch=moderate` is a no-op for
  Google, `includeAds` reflects ads via `packs`, cold-cache paid `regionsTree` warning).
- **xmlstock**: SERP/Wordstat HTTP layer and helpers moved to `servers/xmlstock/src/serp.ts`
  for unit-testability; the unknown-region error now points to `xmlstock_wordstat_regions_tree`.
- **xmlriver**: SERP/vertical responses include `truncated` and `empty`/`note` for billed empty
  SERPs (code 15); the SERP HTTP layer and helpers moved to `servers/xmlriver/src/serp.ts`;
  validation tightened (`searchDomain`/`lang` regex); descriptions spell out the response shape,
  per-page pricing and the Google-only `safeSearch`.
- **.env.example**: added the XMLRIVER and APARSER sections.
- **tests**: new `tests/xmlriver-serp.test.ts` (pagination, retries, error codes, `checkIndex`);
  live smoke now also covers `xmlriver_balance`.
- **wordstat**: responses enriched — `wordstat_regions` returns `total` + `truncated` (true = the
  result was cut by `limit`) and `region_names_resolved` (false = the name tree failed to load,
  `region_name` is null); `wordstat_frequency` returns `related_truncated`
  (`related.length >= relatedLimit`).
- **wordstat**: pure logic (`wordstatPost` with error classification, `resolveDevices`, `toNum`,
  `hasOperators`, `exactForm`, `validateDynamicsDates`, region-names cache factory) moved to
  `servers/wordstat/src/wordstat.ts` for unit-testability; descriptions clarified (the API is
  free with a 100/hour quota; `wordstat_regions` costs 2 API requests on a cold daily cache,
  then 1; `region`/`device` value lists).
- **tests**: new `tests/wordstat.test.ts` (operators/exact form, devices, region-cache in-flight
  dedup + TTL, dynamics date validation, 401/403/429 classification).
- **ywm**: pure logic (HTTP layer with error classification, `resolveHost`, `getUserId`,
  query-analytics pagination, `aggregate`, MSK `dateRange`, `filterRecommended`) moved to
  `servers/ywm/src/queries.ts` for unit-testability; `index.ts` is registration-only.
- **ywm**: `truncated` unified across tools — `ywm_popular` (true only when the row cap was hit,
  not on a short last page), `ywm_external_links`/`ywm_broken_links` (computed from the API
  `count`), `ywm_search_queries`/`ywm_recommended_queries` (replaces the ad-hoc `approximate`).
- **ywm**: `ywm_search_queries` accepts `dateFrom`/`dateTo` (the API defaults to ~2 weeks);
  `ywm_recommended_queries` description honestly lists all three categories
  (shows without clicks, position beyond top-10, any demand) mirrored in the `reason` field;
  parameter descriptions spell out `hostId` format, response shapes and limit defaults/maxes;
  `server.json` declares `YWM_OAUTH_TOKEN`/`YANDEX_CLIENT_ID`/`YANDEX_CLIENT_SECRET`.
- **tests**: new `tests/ywm.test.ts` (`getUserId` validation + in-flight dedup, 403/404
  classification, `aggregate`, null-position sorting, MSK date ranges, `resolveHost`,
  `filterRecommended` categories).
- **metrika** (BREAKING for 3 tools): `bounceRate` is now returned as a percent (0–100) in
  `metrika_landing_behavior`, `metrika_search_phrases` and `metrika_top_landings` — previously
  these three divided the API value by 100 and returned a fraction (0–1). The unit is now
  consistent across ALL metrika tools (runReport-based tools already returned the raw percent)
  and is spelled out in the descriptions.
- **metrika**: responses enriched — `truncated` (rows cut by `limit`) added to `metrika_report`,
  `metrika_bytime`, `metrika_search_phrases`, `metrika_top_landings`; `totalRows` added to
  `metrika_top_landings`; `sample_share` is passed through whenever `sampled: true`;
  `metrika_counters` requests `rows=10000` and flags `truncated` if more counters exist.
- **metrika**: pure logic (MSK `metrikaDates`, `validateDateRange`/`accuracyError`,
  `resolveCounterId`, the goals cache factory, `clipGoalIds`, `mapLandingTotals`, the Stat/
  Management HTTP layer with error classification) moved to `servers/metrika/src/utils.ts` for
  unit-testability; the duplicated `baseMetrics` copy is gone (`SESSION_METRICS` is the single
  source); the header comment and parameter descriptions were aligned with the actual behavior
  (shared `YANDEX_OAUTH_TOKEN`, last-significant-source attribution, filter syntax examples).
- **tests**: new `tests/metrika-utils.test.ts` (MSK dates, date-range/accuracy validation,
  response-shape errors, goals-cache dedup/TTL/account keying, goal clipping markers,
  bounceRate units).

## [1.3.0] — 2026-07-26

### Added
- **XMLStock server: Yandex Wordstat** (endpoint `/wordstat/json/`, official Wordstat API v2) —
  new tools `xmlstock_wordstat` (top + related queries with frequency, region-scoped, Wordstat
  operators), `xmlstock_wordstat_dynamics` (frequency over time), `xmlstock_wordstat_regions`
  (demand by region + affinity index, region names resolved), `xmlstock_wordstat_regions_tree`.
  Uses the same `XMLSTOCK_*` key as SERP — no separate Yandex Cloud setup. Verified against the live API.

## [1.2.1] — 2026-07-22

### Changed
- Promo/branding in all READMEs renamed **Satellite1 → PBN Workers** (site
  [pbn-workers.com](https://pbn-workers.com/tools/seo-tools-mcp/)). Docs only, no code changes.

## [1.2.0] — 2026-07-18

### Added
- **New server `xmlriver`** — Google/Yandex SERP via [XMLRiver](https://xmlriver.com), a second
  SERP provider alongside XMLStock. Tools: `xmlriver_serp` (organic, depth in one request via
  `groupby`, AI-Overview presence flag), `xmlriver_images`, `xmlriver_news`, `xmlriver_check_index`
  (URL indexation check — Google, unique to XMLRiver), `xmlriver_balance`. All requests over HTTPS.
  Verified end-to-end against the live API.
- The shared Yandex.XML SERP parser now lives in `@seo-tools/shared/serp` and is used by both
  XMLStock and XMLRiver (kept out of non-SERP server bundles).

### Changed
- Docker images: build one server's dependencies only (filtered install), `tini` as PID 1,
  manifest-first layer caching.

## [1.1.0] — 2026-07-17

Major read-only tool expansion across all servers (~14 → ~38 tools), verified against live APIs.

### Added
- **GSC**: `gsc_inspect_url` (URL Inspection — index status, coverage, canonical, last crawl,
  mobile usability, rich results), `gsc_list_sitemaps`, `gsc_get_sitemap`, `gsc_get_site`;
  `dataState` (final/all) on `gsc_query`.
- **XMLStock**: Google verticals `xmlstock_images`, `xmlstock_news`, `xmlstock_video`; plus
  `safeSearch`, `includeSimilar` (Google) and `filter`, `sortby`, `maxpassages`, `l10n` (Yandex)
  on `xmlstock_serp`.
- **Wordstat**: `wordstat_regions` now resolves `region_id` → region name (cached).
- **YWM**: `ywm_summary`, `ywm_sqi_history`, `ywm_indexing_history`, `ywm_external_links`
  (backlinks), `ywm_broken_links`, `ywm_diagnostics`, `ywm_important_urls`, `ywm_sitemaps`,
  `ywm_queries_history`.
- **Metrica**: `metrika_report` (arbitrary dimensions × metrics), `metrika_bytime` (time series),
  `metrika_traffic_sources`, `metrika_geo`, `metrika_devices`, `metrika_goals`.
- Unit tests for the new pure logic (SERP-vertical parsers, region flattening, report mapping).

## [1.0.2] — 2026-07-17

### Added
- Richer MCP Registry metadata in each `server.json`: `title`, `websiteUrl` and
  `environmentVariables` (documents the credentials/defaults each server accepts,
  with `isSecret`/`isRequired`). No functional changes to the servers.
- `repository` field in the Open Plugins manifest (`.plugin/plugin.json`).

## [1.0.1] — 2026-07-17

### Added
- Listed on the official [MCP Registry](https://registry.modelcontextprotocol.io) under
  `io.github.antohins/seo-tools-mcp-*`: added the `mcpName` field to each package and a
  per-server `server.json`.

## [1.0.0] — 2026-07-17

First public release. Each server is published to npm as `seo-tools-mcp-<server>` and
installable via `npx -y seo-tools-mcp-<server>`.

### Added
- Five read-only stdio MCP servers for SEO: `xmlstock` (Google/Yandex SERP), `wordstat`
  (Yandex keyword frequencies), `gsc` (Google Search Console), `ywm` (Yandex.Webmaster),
  `metrika` (Yandex.Metrica).
- Single env-file config (`~/.config/seo-tools-mcp/.env`, mode 600), multi-account named
  profiles, interactive OAuth (Google, Yandex) with automatic token refresh, strict JSON output.
- Shared HTTP client with retries (429/5xx, Retry-After, exponential backoff + jitter) and a
  configurable `retryOn(status)`; secrets masked in logs (`maskUrl`, `maskSecret`).
- npm packaging: self-contained bundles per server (shared bundled in via tsup, `bin` entry).
- Unit tests (vitest) — secret masking, OAuth error classification, Metrica/GSC pagination
  (dedup, `truncated`), filters, SERP parser, regions — plus an opt-in live smoke.
- GitHub Actions CI (lint + build + typecheck + test), Biome linter/formatter, README in
  Russian and English.

### Reliability
- Yandex OAuth: refresh token rewritten only on actual rotation; a second 401 right after
  refresh becomes an explicit "re-authorize" terminal error; `force_confirm` only for named
  multi-account profiles; transient (5xx/timeout) refresh failures are not mistaken for a dead grant.
- GSC: whole-pagination deadline guards against compounding timeouts on slow endpoints;
  accurate `truncated` flag; 120s per-request timeout.
- Metrica: pagination advances by rows actually read (no lost rows on short pages), with
  dedup and a no-progress break.
- Yandex region directory (~55 entries + aliases), all ids verified against the Wordstat tree;
  any numeric id works.

[Unreleased]: https://github.com/antohins/seo-tools-mcp/compare/v1.7.0...HEAD
[1.7.0]: https://github.com/antohins/seo-tools-mcp/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/antohins/seo-tools-mcp/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/antohins/seo-tools-mcp/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/antohins/seo-tools-mcp/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/antohins/seo-tools-mcp/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/antohins/seo-tools-mcp/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/antohins/seo-tools-mcp/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/antohins/seo-tools-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/antohins/seo-tools-mcp/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/antohins/seo-tools-mcp/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/antohins/seo-tools-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/antohins/seo-tools-mcp/releases/tag/v1.0.0
