<p align="center">
  <img src="assets/logo-128.png" width="96" height="96" alt="seo-tools-mcp" />
</p>

# seo-tools-mcp

[![CI](https://github.com/antohins/seo-tools-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/antohins/seo-tools-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Русский](README.md) | **English**

Eight **general-purpose** stdio MCP servers for SEO: access to SERP, Wordstat, Google Search Console, Google Analytics 4, Yandex.Webmaster, Yandex.Metrica and self-hosted A-Parser straight from Claude Code (or any MCP client). All tools are **read-only**, output is strict JSON. Not tied to a specific site: defaults (GSC property, GA4 property, Webmaster host, Metrica counter) are configured on the fly.

> 🛰 We use these servers in production at **[PBN Workers](https://pbn-workers.com/tools/seo-tools-mcp/)** — search-visibility infrastructure: semantic cores, PBN & satellites, SEO automation. Need steady organic traffic? [Get in touch](https://pbn-workers.com/tools/seo-tools-mcp/).

| Server | Tools | Auth |
|---|---|---|
| `xmlstock` | `xmlstock_serp`, `xmlstock_images`, `xmlstock_news`, `xmlstock_video`, `xmlstock_wordstat`, `xmlstock_wordstat_dynamics`, `xmlstock_wordstat_regions`, `xmlstock_wordstat_regions_tree`, `xmlstock_balance` | API key |
| `xmlriver` | `xmlriver_serp`, `xmlriver_images`, `xmlriver_news`, `xmlriver_maps`, `xmlriver_check_index`, `xmlriver_suggest`, `xmlriver_related_questions`, `xmlriver_balance` | API key |
| `wordstat` | `wordstat_frequency`, `wordstat_dynamics`, `wordstat_regions`, `wordstat_regions_tree` | Api-Key Yandex Cloud |
| `gsc` | `gsc_query`, `gsc_inspect_url`, `gsc_list_sites`, `gsc_get_site`, `gsc_list_sitemaps`, `gsc_get_sitemap` | OAuth (all account properties) / service account |
| `ga4` | `ga4_list_properties`, `ga4_metadata`, `ga4_check_compatibility`, `ga4_report`, `ga4_bytime`, `ga4_traffic_sources`, `ga4_geo`, `ga4_devices`, `ga4_top_pages`, `ga4_events`, `ga4_realtime`, `ga4_funnel`, `ga4_annotations`, `ga4_property_details` | OAuth (all account properties) / service account |
| `ywm` | `ywm_hosts`, `ywm_summary`, `ywm_search_queries`, `ywm_queries_history`, `ywm_recommended_queries`, `ywm_popular`, `ywm_indexing_history`, `ywm_sqi_history`, `ywm_external_links`, `ywm_broken_links`, `ywm_diagnostics`, `ywm_important_urls`, `ywm_sitemaps` | OAuth (auto-refresh) |
| `metrika` | `metrika_report`, `metrika_bytime`, `metrika_counters`, `metrika_goals`, `metrika_traffic_sources`, `metrika_geo`, `metrika_devices`, `metrika_landing_behavior`, `metrika_search_phrases`, `metrika_top_landings` | OAuth (auto-refresh) |
| `aparser` | `aparser_ping`, `aparser_status`, `aparser_proxies`, `aparser_parsers`, `aparser_parser_fields`, `aparser_get_preset`, `aparser_serp_google`, `aparser_serp_yandex`, `aparser_suggest`, `aparser_request`, `aparser_bulk_request` | self-hosted A-Parser (API URL + password) |

> **Regional focus:** XMLStock covers both Google and Yandex SERP, while Wordstat, Webmaster and Metrica are Yandex services — this toolkit is most useful for SEO on the Russian/CIS market (though GSC and the Google side of XMLStock are global).

Every server additionally exposes auth tools `<server>_auth_status` and `<server>_set_credentials` (see [Interactive authorization](#interactive-authorization-any-session)).

## Tools by server

### xmlstock — Google/Yandex SERP
- `xmlstock_serp` — Google/Yandex web SERP (organic + highlights + SERP features): region, device, safe search, sort (Yandex), time period, ad blocks; third engine `yandex_xml` — official Yandex XML (groupby up to 100 per single request, hlword highlights on any device, found/found-docs stats; rate from 24 ₽/1000)
- `xmlstock_images` — Google image search (page url + image url + title)
- `xmlstock_news` — Google news (title, source, date, snippet)
- `xmlstock_video` — Google video (url, title, thumbnail, host, channel, duration)
- `xmlstock_wordstat` — Yandex Wordstat: top + related queries with frequency (region-scoped), Wordstat operators
- `xmlstock_wordstat_dynamics` — frequency over time (day/week/month)
- `xmlstock_wordstat_regions` — demand by region (count, share, affinity index + region names)
- `xmlstock_wordstat_regions_tree` — Wordstat region tree (id + name + path)
- `xmlstock_balance` — account balance / key check (free)

> Wordstat via XMLStock uses the same `XMLSTOCK_*` key as SERP — **no Yandex Cloud setup** needed (unlike the standalone `wordstat` server).

### xmlriver — Google/Yandex SERP + indexation check
- `xmlriver_serp` — Google/Yandex organic SERP (depth collected by pagination: every 10 positions = 1 paid request), AI-Overview presence flag; `includeAIOverview` option — full AI Overview text + cited links (paid `ai=1`, Google only); `includeAdditional` — extra Google SERP blocks from `<addresults>` (knowledge_graph, localresultsplace, rs, etc.; block content depends on paid options enabled in the XMLRiver dashboard, missing blocks are listed in `additional.unavailable`); Google geo-targeting — `location` (city → `loc`, "Moscow"/"1011969") and `country` (ISO/numeric id, auto-derived from the city); `device` — desktop/mobile/tablet, `os` (ios/android) is sent only with `device=mobile`
- `xmlriver_images` — Google image search (page url + image url + title + source + dimensions); geo via `location`/`country`
- `xmlriver_news` — Google news (title, source, date, snippet), time filter; geo via `location`/`country`
- `xmlriver_maps` — Google Maps place search (`setab=maps`, mandatory `zoom` 1–15 and `coords` "lat,lng", `count` 5–50): title, rating, address, phone, features, coordinates, place_id, review count. NOTE: format per the docs, not live-verified (the endpoint steadily returns error 500 on the test account — a paid dashboard option is likely required)
- `xmlriver_check_index` — check whether a URL is indexed in Google/Yandex (`inindex`)
- `xmlriver_suggest` — Google search suggestions (up to 50 phrases per call, billed per phrase); geo via `location`/`country`
- `xmlriver_related_questions` — Google "People Also Ask" block (questions always returned; answers only with the paid "Related Questions with answers" option enabled in the XMLRiver dashboard)
- `xmlriver_balance` — account balance / key check (free)

### wordstat — Yandex keyword frequencies
- `wordstat_frequency` — broad + exact frequency, refining queries (related) and associations
- `wordstat_dynamics` — frequency over time (daily/weekly/monthly)
- `wordstat_regions` — regional distribution with affinity index and resolved region names
- `wordstat_regions_tree` — full Wordstat region tree (id + name)

### gsc — Google Search Console
- `gsc_query` — Search Analytics (clicks/impressions/CTR/position), auto-pagination, `dataState` final/all, arbitrary dimension filters (`filters`, AND semantics) and `aggregationType` (auto/byProperty/byPage)
- `gsc_inspect_url` — URL Inspection: index status, coverage, canonical, last crawl, mobile usability, rich results
- `gsc_list_sites` — properties available to the authorization
- `gsc_get_site` — permission level for a property
- `gsc_list_sitemaps` — submitted sitemaps with status
- `gsc_get_sitemap` — details for one sitemap

Search Analytics dates are in Pacific Time (not MSK); history is ~16 months; final data lags by ~2-3 days (fresh data via `dataState=all`); `ctr` in the response is a 0..1 fraction.

### ga4 — Google Analytics 4
- `ga4_list_properties` — GA4 properties available to the authorization (this is where `propertyId` comes from — it is **not** the `G-XXXXXXX` Measurement ID)
- `ga4_metadata` — dimensions and metrics available in THIS property, custom ones included (`customEvent:…`); substring search, `blockedReasons` (such a metric returns zeros) and `type` (int vs float for `metricFilters`)
- `ga4_check_compatibility` — whether a dimension/metric combination is valid for this property, without running a heavy report; on failure it names the fields to remove
- `ga4_report` — arbitrary report: any dimensions × metrics, dimension filters, sorting (full Data API `runReport`)
- `ga4_bytime` — metrics over time (date/hour/week/month)
- `ga4_traffic_sources` — channel group, source/medium, campaign; `organicOnly` for organic search only
- `ga4_geo` — country/region/city
- `ga4_devices` — device category/OS/browser
- `ga4_top_pages` — top pages by `pagePath`, landing page or title; `organicOnly` and `pathContains` filters
- `ga4_events` — events by `eventName`; `keyEventsOnly` for key events (former conversions)
- `ga4_realtime` — realtime report (last 30 minutes)
- `ga4_funnel` — funnel (`runFunnelReport`): how many reached each step and where they dropped off; a step is an event and/or dimension conditions, with an optional breakdown. Steps follow the Exploration API schema (`pagePath` is unavailable there), the quota bucket is separate and a call costs more than a plain report
- `ga4_annotations` — property annotations: notes pinned to dates, including ones GA4 generated itself (`systemGenerated`) — often the explanation for an unexplained jump in a trend
- `ga4_property_details` — property card: reporting time zone, currency, service level (STANDARD/360) and data streams with their `G-XXXXXXX` Measurement IDs

Units and dates: GA4 returns `bounceRate`/`engagementRate` as a **0..1 fraction**, not a percent; dates resolve in the **property's** timezone — pass `YYYY-MM-DD` or GA4 keywords (`today`, `yesterday`, `28daysAgo`), and the applied timezone comes back in the response. Responses carry `totalRows`/`truncated`, and `thresholded: true` means part of the data is hidden behind GA4's privacy threshold.

### ywm — Yandex.Webmaster
- `ywm_hosts` — user id + verified sites
- `ywm_summary` — SQI, pages in search, excluded, site problems by severity
- `ywm_search_queries` — query analytics for a URL (~2 weeks by default; override with dateFrom/dateTo)
- `ywm_queries_history` — total shows/clicks/positions over time
- `ywm_recommended_queries` — approximated recommended queries (demand + click shortfall)
- `ywm_popular` — popular queries of the host
- `ywm_indexing_history` — pages in search over time
- `ywm_sqi_history` — SQI over time
- `ywm_external_links` — external backlinks sample + total count
- `ywm_broken_links` — broken internal/external links
- `ywm_diagnostics` — site problems
- `ywm_important_urls` — monitored URLs with indexing/search status
- `ywm_sitemaps` — sitemaps with status

### metrika — Yandex.Metrica
- `metrika_report` — arbitrary report: any dimensions × metrics, filters, sort (full Stat API)
- `metrika_bytime` — metrics over time (day/week/month/hour)
- `metrika_traffic_sources` — visits/users/bounce by traffic source
- `metrika_geo` — visits by country/region/city
- `metrika_devices` — visits by device/OS/browser
- `metrika_goals` — list of conversion goals
- `metrika_counters` — accessible counters
- `metrika_landing_behavior` — landing-page behavior + goal reaches
- `metrika_search_phrases` — organic search phrases
- `metrika_top_landings` — top organic landing pages

### aparser — bridge to a self-hosted A-Parser
- `aparser_ping` — instance connectivity + API password check
- `aparser_status` — readiness verdict: version, installed parsers, queue, live proxies
- `aparser_proxies` — live proxies on the instance (filterable by proxy-checker packs; proxy credentials never shown)
- `aparser_parsers` — parsers installed on the instance
- `aparser_parser_fields` — result fields a parser can return (flat + arrays)
- `aparser_get_preset` — read a config preset's options (sensitive values are masked)
- `aparser_serp_google` — Google organic SERP (`SE::Google`); proxies on by default + live-proxy preflight
- `aparser_serp_yandex` — Yandex organic SERP (`SE::Yandex`); region via `lr`
- `aparser_suggest` — Google/Yandex search suggestions
- `aparser_request` — universal synchronous request to any parser (`oneRequest`)
- `aparser_bulk_request` — bulk request: one parser, many queries, N threads (`bulkRequest`)

> You need your **own** running [A-Parser](https://a-parser.com/?ref=38832) instance (licence + server): the bridge drives it but does not host or proxy it for you. Proxies and proxy checkers (packs) are configured once in the A-Parser GUI — the bridge reads, verifies (preflight) and selects them (`checkers`), but does not create them. v1 is synchronous and read-only: the task queue and large async exports are not wired up.

## Quick start

### Option 1 — one click for Claude Desktop (.mcpb)

The simplest path, nothing to install by hand: grab the `.mcpb` you need from the [latest release](https://github.com/antohins/seo-tools-mcp/releases/latest) and **double-click it** — Claude Desktop installs the server and asks for the keys in its own dialog.

- API-key servers (`xmlstock`, `xmlriver`, `wordstat`, `aparser`) ask for the keys right in the installer.
- OAuth servers (`gsc`, `ga4`, `ywm`, `metrika`) ask for nothing: you authorize in chat (`<server>_oauth_start` → `<server>_oauth_finish`).

Bundles are self-contained (~0.2 MB, dependencies inlined); Node.js 20+ is only needed for the npx route. Build them yourself with `pnpm build:mcpb`.

### Option 2 — a Claude Code plugin (marketplace)

The `.mcpb` equivalent for Claude Code: one command installs the server, asks for the keys in a dialog and stores secrets in the OS keychain rather than a plaintext file.

```bash
claude plugin marketplace add antohins/seo-tools-mcp
```

Then install **only the sources you need** — one plugin pulls exactly one server:

```bash
claude plugin install xmlstock@seo-tools-mcp
claude plugin install gsc@seo-tools-mcp
claude plugin install ga4@seo-tools-mcp
```

Available: `xmlstock`, `xmlriver`, `wordstat`, `gsc`, `ga4`, `ywm`, `metrika`, `aparser` — plus `seo-tools`, which installs all eight at once. The bundle is convenient but costs ~100 tools in every session: if you only work with Webmaster and Metrica, install those two plugins instead.

Keys can be passed up front (`--config KEY=VALUE`) or set later via `/plugin configure <plugin>@seo-tools-mcp`:

```bash
claude plugin install xmlstock@seo-tools-mcp --config XMLSTOCK_USER=12345 --config XMLSTOCK_KEY=...
```

Fields marked sensitive (API keys, OAuth secrets) go to the OS keychain and never reach `settings.json`. The OAuth plugins (`gsc`, `ga4`, `ywm`, `metrika`) only ask for a client id/secret at install time — the sign-in itself happens in chat via `<server>_oauth_start` → `<server>_oauth_finish`.

Each plugin also ships **skills** — procedural notes on its own data source: how not to burn
the balance while tracking positions, why Wordstat's broad frequency overstates traffic several
times over, what makes GA4 silently return zeros, how an averaged GSC position differs from one
scraped off the SERP. They cost ~110 tokens each in context and expand only when actually needed.

### Option 3 — via npx (no cloning)

Each server is a self-contained npm package `seo-tools-mcp-<server>`; add it with one command:

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

#### Need just one server?

The servers are **independent**: take a single package and ignore the rest. Each is self-contained — the shared `@seo-tools/shared` code is bundled into the build, so there's no extra dependency or monorepo tail. Just install the package you need from npm — everything is included out of the box (`npx -y` downloads and runs it for you):

| Package (npm) | Server |
|---|---|
| [`seo-tools-mcp-xmlstock`](https://www.npmjs.com/package/seo-tools-mcp-xmlstock) | Google/Yandex SERP + Wordstat |
| [`seo-tools-mcp-xmlriver`](https://www.npmjs.com/package/seo-tools-mcp-xmlriver) | Google/Yandex SERP + indexation check |
| [`seo-tools-mcp-wordstat`](https://www.npmjs.com/package/seo-tools-mcp-wordstat) | Yandex keyword frequencies (Yandex Cloud) |
| [`seo-tools-mcp-gsc`](https://www.npmjs.com/package/seo-tools-mcp-gsc) | Google Search Console |
| [`seo-tools-mcp-ga4`](https://www.npmjs.com/package/seo-tools-mcp-ga4) | Google Analytics 4 |
| [`seo-tools-mcp-ywm`](https://www.npmjs.com/package/seo-tools-mcp-ywm) | Yandex.Webmaster |
| [`seo-tools-mcp-metrika`](https://www.npmjs.com/package/seo-tools-mcp-metrika) | Yandex.Metrica |
| [`seo-tools-mcp-aparser`](https://www.npmjs.com/package/seo-tools-mcp-aparser) | bridge to a self-hosted A-Parser |

```bash
# add a single server to Claude Code
claude mcp add xmlstock --scope user -- npx -y seo-tools-mcp-xmlstock

# or run it directly (keys via env)
XMLSTOCK_USER=... XMLSTOCK_KEY=... npx -y seo-tools-mcp-xmlstock
```

In any MCP client (Claude Desktop, Cursor…) it's a single block in `mcpServers`:

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

> Installing a single package straight from the GitHub URL (`npm i github:antohins/seo-tools-mcp`) is **not supported**: it's a pnpm monorepo, so an individual subpackage can't be installed that way. To install from source, use Option 4 below (clone + build). The ready-to-use packages live on npm.

### Option 4 — from source

```bash
git clone https://github.com/antohins/seo-tools-mcp.git && cd seo-tools-mcp
pnpm install && pnpm build
ROOT=$(pwd)
for s in xmlstock xmlriver wordstat gsc ga4 ywm metrika aparser; do
  claude mcp add "$s" --scope user -- node "$ROOT/servers/$s/dist/index.js"
done
```

Then (either option), **right in the Claude Code chat**: "set up access to xmlstock" → the agent calls `xmlstock_auth_status`, tells you which keys are needed and where to get them, accepts them via `xmlstock_set_credentials` and saves them. After that, just ask in plain language: "pull top-10 Yandex results for query X", "keyword frequency for …", "clicks/impressions from GSC for the month". Keys and OAuth are set up once (see [Getting access](#getting-access-per-service)).

## Interactive authorization (any session)

Every server has auth tools — credentials can be provided right in the chat, no file edits or restarts:

- `<server>_auth_status` — call it at the start: shows which keys are set (masked), which are missing, and how to obtain them (registration steps).
- `<server>_set_credentials` — saves the provided values to `~/.config/seo-tools-mcp/.env` (mode 600) and applies them immediately.
- `gsc_save_sa_json` — accepts the contents of a service-account JSON key, stores it in the config dir and returns the email to add in GSC.
- `ywm_oauth_start` / `metrika_oauth_start` → a Yandex authorization link; the user opens it, grants access, copies the code → `*_oauth_finish` exchanges the code for access + refresh tokens. After that the token is **refreshed automatically** on expiry (code flow, not implicit).

Typical new-session flow: "set up access to xmlstock" → the agent calls `xmlstock_auth_status` → asks for the missing keys → `xmlstock_set_credentials` → works.

⚠ Keys passed through chat go through the model's context. For maximum hygiene you can still write them into `~/.config/seo-tools-mcp/.env` by hand — the servers pick the file up on their own.

## Multi-account

Client sites are spread across different Google/Yandex accounts — **named profiles** are supported:

- Every tool accepts an optional **`account`** parameter ("clientX", "agency"…). Without it the main profile is used — fully backward compatible.
- Profile keys are stored in the same config with a suffix: `GSC_REFRESH_TOKEN__clientX`, `YANDEX_OAUTH_TOKEN__clientX`, `XMLSTOCK_KEY__clientX`…
- Adding a profile: `gsc_oauth_start(account="clientX")` → the user authorizes under a **different** Google account → `gsc_oauth_finish(account="clientX")`. Same for `ywm_oauth_start/finish(account=...)` for Yandex; API keys — `<server>_set_credentials(account="clientX", ...)`.
- **OAuth apps are shared**: one Google client and one Yandex app serve all profiles (create the client once, authorize as many times as you like). Only tokens are stored per account; refresh updates the token of its own profile.
- Resolution is strict: `account="clientX"` without configured keys → an error listing the configured profiles (no silent fallback into someone else's account). Defaults (`GSC_SITE_URL__clientX`, `YWM_HOST_ID__clientX`, `METRIKA_COUNTER_ID__clientX`) are per-account too.
- `<server>_auth_status` shows all profiles and their keys (masked).
- For hard isolation: a separate env file via `SEO_TOOLS_MCP_ENV` (when set, the home config is NOT read).

## Install

```bash
cd seo-tools-mcp
pnpm install
pnpm build
```

## Secrets

Single env file: `~/.config/seo-tools-mcp/.env` (mode 600). All servers read it at startup, and `*_set_credentials`/`*_oauth_finish` write to it themselves — manual editing is optional. Template — [.env.example](.env.example). Process environment variables take precedence over the file. Alternative file path — `SEO_TOOLS_MCP_ENV` (so one host can hold several independent profiles: different `claude mcp add` with different `SEO_TOOLS_MCP_ENV`).

## Registering in Claude Code

```bash
ROOT=/path/to/seo-tools-mcp
claude mcp add xmlstock --scope user -- node $ROOT/servers/xmlstock/dist/index.js
claude mcp add wordstat --scope user -- node $ROOT/servers/wordstat/dist/index.js
claude mcp add gsc      --scope user -- node $ROOT/servers/gsc/dist/index.js
claude mcp add ga4      --scope user -- node $ROOT/servers/ga4/dist/index.js
claude mcp add ywm      --scope user -- node $ROOT/servers/ywm/dist/index.js
claude mcp add metrika  --scope user -- node $ROOT/servers/metrika/dist/index.js
```

`--scope user` — available in all sessions/projects. To share with a team — `--scope project` (creates `.mcp.json` in the repo; inject secrets only via `${VAR}`).

## Getting access (per service)

> Everything in this section is also duplicated in `<server>_auth_status` responses — the agent will guide you. Below is for human reading.

### XMLStock — Google + Yandex SERP

1. Register at https://xmlstock.com → dashboard, top up the balance (Google XML and Yandex Live — from ~12 RUB / 1000 requests).
2. Grab the user ID and API key → `XMLSTOCK_USER`, `XMLSTOCK_KEY` (or via `xmlstock_set_credentials`).
3. Check: `xmlstock_balance`.

Notes (verified on live responses):
- SERP highlights (`text_bolds`) — parameter `hlword=1`, tag `<hlword>` as nested XML (parsed via stopNodes, adjacent words merged into phrases); PAA and related searches — `related=1` (PAA is Google-only);
- **mobile SERP does not return hlword/PAA/related** — the mobile snapshot is positions + snippets only, take highlights from desktop;
- pages start at 0 for both engines; organic results per page can be <10 — the server tops up with an extra page (+1 paid request);
- `lr` accepts Yandex region IDs for both engines (XMLStock maps them to Google itself);
- errors arrive as HTTP 200 + `<error code>`: 20–25/101/110/111/500 are retried, 55 — rate-limit with a pause, 15 = empty SERP (charged), 31/42 — fatal (auth);
- **Wordstat is NOT available via XMLStock** — frequencies go through a separate server (official Yandex Wordstat API).

### Wordstat — Yandex keyword frequencies

Official **Wordstat API v2** (part of Yandex Cloud Search API) — free, no application form or OAuth. Once, in https://console.yandex.cloud:

1. Create a folder (or use an existing one) → its ID goes to `WORDSTAT_FOLDER_ID`.
2. Create a service account with the role **`search-api.webSearch.user`**.
3. Issue an **API key** for it with scope **`yc.search-api.execute`** → `WORDSTAT_API_KEY`.
4. Check: `wordstat_frequency` for any phrase.

Notes: exact frequency = `"!word !word"` operators (supported in topRequests/regions; in dynamics — only with period=daily); topRequests data is for the last 30 days; `count` arrives as strings (parsed); quotas **10 rps / 100 requests per hour** (429 is retried, but plan throttling for bulk pulls); associations max 20.

### Google Search Console

Two paths; **recommended — OAuth**: the token inherits your Google account's access and sees **all its GSC properties at once** (including future ones), no need to add a user to each property.

**Path A — OAuth (once):**

1. https://console.cloud.google.com → project → APIs & Services → Library → enable **Google Search Console API**.
2. **OAuth consent screen**: type External; add yourself to Test users. (For a refresh token lasting longer than 7 days — click **Publish app**; the "unverified" warning at auth time is normal for personal use.)
3. **Credentials → Create credentials → OAuth client ID → Desktop app** → grab client ID + secret.
4. In chat: `gsc_oauth_start` (pass clientId+secret) → open the link → grant access → the browser redirects to `localhost:8585`, the code is picked up automatically → `gsc_oauth_finish`.
5. Check: `gsc_list_sites` — shows all account properties.

**Path B — service account (for headless crons):** IAM → Service Accounts → JSON key → `gsc_save_sa_json` (or path in `GSC_SA_JSON`) → add the account's email to **each** needed GSC property (Settings → Users and permissions, "Full").

If both are set — OAuth wins.

### Google Analytics 4

Same two paths as GSC, and the **OAuth app is shared** (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are reused). GA4 has its own scope, so it needs its own one-time authorization.

1. In the same Cloud project → APIs & Services → Library → enable **Google Analytics Data API** and **Google Analytics Admin API**.
2. In chat: `ga4_oauth_start` (no arguments needed if the client ID/secret are already saved for GSC) → open the link → grant access → the browser redirects to `localhost:8586` (a different port from GSC so both servers can run at once), the code is picked up automatically → `ga4_oauth_finish`.
3. Check: `ga4_list_properties` — shows all account properties and their `propertyId`.
4. Handy: save a default property via `ga4_set_credentials` → `GA4_PROPERTY_ID` (the numeric id from step 3), otherwise pass `propertyId` on every call.

**Path B — service account:** JSON key → `ga4_save_sa_json` → add the account's email to the GA4 property (Admin → Property access management, "Viewer").

### Yandex OAuth (Webmaster + Metrica — one app, one token)

1. Once: https://oauth.yandex.ru/client/new → "Web services", Redirect URI: `https://oauth.yandex.ru/verification_code`. Scopes: **Yandex.Webmaster** — "Get information about sites" (`webmaster:hostinfo`) + "Manage sites" (`webmaster:verify`); **Yandex.Metrica** — "Get statistics" (`metrika:read`). Grab ClientID and Client secret.
2. Then, interactively in chat: `ywm_oauth_start` (pass ClientID + secret, they are saved) → open the link under the account that owns the site/counter → copy the code → `ywm_oauth_finish`. You get access + refresh tokens shared by ywm and metrika; **refreshed automatically**.
3. Defaults: `YWM_HOST_ID` (list — `ywm_hosts`), `METRIKA_COUNTER_ID` (list — `metrika_counters`) — set via `*_set_credentials`, or pass on each call.
4. Manual alternative: get an implicit-flow token (`response_type=token`) and store it in `YANDEX_OAUTH_TOKEN` — but without refresh it expires (Webmaster ~6 months, Metrica ~1 year).

Yandex API limitations (not server bugs): URL filtering in Webmaster exists only in query-analytics (data ~2 weeks); there is no "recommended queries" endpoint in API v4 — `ywm_recommended_queries` approximates via demand (DEMAND) + click shortfall; search phrases in Metrica are mostly "Not defined" (encrypted).

### A-Parser (self-hosted) — SERP and hundreds of parsers via your own box

1. Your own running [A-Parser](https://a-parser.com/?ref=38832) instance (licence + server) — the bridge drives it but does not host or proxy it.
2. In A-Parser: **Settings → API** — enable the API server, note the port (usually 9091) and the password.
3. `APARSER_URL` = `http://<instance-IP>:<port>/API` (the `/API` path is required), `APARSER_PASSWORD` = the same password → `aparser_set_credentials`.
4. Check: `aparser_ping`, then `aparser_status` (instance readiness + live proxies).

Notes: proxies and proxy checkers (packs) are configured once in the GUI — without live proxies Google/Yandex ban quickly, so the serp/suggest tools run a preflight and warn (`use_proxy=false` is at your own risk); default presets and packs can be set via env (`APARSER_GOOGLE_PRESET`, `APARSER_YANDEX_PRESET`, `APARSER_PROXY_CHECKERS`, `APARSER_USE_PROXY`); v1 is synchronous and read-only — the task queue and mutating API methods are not wired up.

## Date format and regions

Dates — `YYYY-MM-DD` (MSK). Regions: a name from the built-in list of common regions ("Москва", "спб", "Казахстан"…) **or** a numeric Yandex region ID (`213`, `225`…) — a numeric ID always works. Comma-separated region lists are supported only by the `wordstat` server; the `xmlstock_*`/`xmlriver_*` SERP tools take ONE region. Full ID directory — the `wordstat_regions_tree` tool.

## Where and how to use it

The servers are ordinary stdio processes, not tied to a machine. Four scenarios:

### 1. Claude Code, local

Register via `claude mcp add --scope user` (the "Registering in Claude Code" block above) — available in all projects and sessions.

### 2. Claude Code, another machine

```bash
git clone https://github.com/antohins/seo-tools-mcp.git && cd seo-tools-mcp
pnpm install && pnpm build
# register the servers (the "Registering in Claude Code" block above)
# keys: copy ~/.config/seo-tools-mcp/.env from the old machine (chmod 600)
# OR provide them in chat via <server>_auth_status → <server>_set_credentials
```

### 3. Claude Desktop (local)

In `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`):

```json
{
  "mcpServers": {
    "xmlstock": { "command": "node", "args": ["/ABS/PATH/seo-tools-mcp/servers/xmlstock/dist/index.js"] },
    "wordstat": { "command": "node", "args": ["/ABS/PATH/seo-tools-mcp/servers/wordstat/dist/index.js"] }
  }
}
```

Keys are picked up from `~/.config/seo-tools-mcp/.env` automatically.

### 4. Remote: claude.ai / Claude Code from anywhere

claude.ai (web/mobile) only supports **remote MCP** (Streamable HTTP over public HTTPS). The stdio servers are exposed on a VPS via the [supergateway](https://github.com/supercorp-ai/supergateway) bridge:

```bash
# on the server: clone/build as in scenario 2, keys in ~/.config/seo-tools-mcp/.env
npx -y supergateway --stateful --outputTransport streamableHttp --port 8801 \
  --stdio "node /opt/seo-tools-mcp/servers/xmlstock/dist/index.js"   # and so on per server, ports 8801–8805
```

Then nginx: TLS + proxy_pass to `127.0.0.1:880X` under a **secret path** (e.g. `/mcp-<long-random-token>/xmlstock/`) — have supergateway listen on localhost only. Connect via:

- **Claude Code**: `claude mcp add --transport http xmlstock https://host/<secret-path>/xmlstock/mcp`
- **claude.ai**: Settings → Connectors → Add custom connector → the same URL.

⚠ The secret path is a minimal gate (claude.ai custom connectors don't pass arbitrary auth headers). Behind the endpoint are all the service keys, so: HTTPS only, a long token in the path, a separate access log.

Alternative for Claude Code without the HTTP bridge — stdio over ssh:

```bash
claude mcp add xmlstock --scope user -- ssh root@SERVER node /opt/seo-tools-mcp/servers/xmlstock/dist/index.js
```

## Development

```bash
pnpm build        # build all workspaces
pnpm typecheck    # types only
pnpm test         # unit tests (vitest, no network)
pnpm test:live    # live smoke against real APIs (needs creds in config; free endpoints)
node servers/xmlstock/dist/index.js   # manual run (stdio)
```

Unit tests cover pure logic: secret masking, OAuth error classification, Metrica/GSC pagination (dedup, `truncated`), filters, the SERP parser, regions. The live smoke boots each server and calls a free tool (`xmlstock_balance`, `xmlriver_balance`, `wordstat_frequency`, `gsc_list_sites`, `ywm_hosts`, `metrika_counters`, `aparser_ping`) — an end-to-end auth check.

Shared code (`shared/`): an HTTP client with retries on 429/5xx (3 attempts, exponential backoff, Retry-After), an env loader + persistent config, an auth-tools factory, Yandex OAuth with auto-refresh, MCP JSON helpers, a paid-call cost counter. XMLStock additionally retries its own "temporary" codes from the XML body; code 15 ("nothing found") is treated as an empty SERP.

Servers are built with `tsup`: `shared/` is bundled into each server's single `dist/index.js` (runtime deps stay external), so each npm package is self-contained.

## Publishing to npm (maintainers)

Each server is published as a separate package `seo-tools-mcp-<server>`; `shared/` is private and not published (it's bundled into the servers). Keep all server versions in sync.

```bash
npm login
pnpm -r build                 # shared (tsc) → servers (tsup bundle)
pnpm -r publish --access public   # publishes the 5 servers; private packages (shared, root) are skipped
```

`pnpm publish` substitutes real versions for `workspace:*` and refuses to publish from a dirty tree. Bump versions with `pnpm -r exec npm version patch` (or by hand in each `package.json`).

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Change history — [CHANGELOG.md](CHANGELOG.md). Vulnerabilities — report privately via [Security Advisories](https://github.com/antohins/seo-tools-mcp/security/advisories/new) (details in [SECURITY.md](SECURITY.md)).

## License

[MIT](LICENSE) © antohins
