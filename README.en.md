<p align="center">
  <img src="assets/logo-128.png" width="96" height="96" alt="seo-tools-mcp" />
</p>

# seo-tools-mcp

[![CI](https://github.com/antohins/seo-tools-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/antohins/seo-tools-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Русский](README.md) | **English**

Six **general-purpose** stdio MCP servers for SEO: access to SERP, Wordstat, Google Search Console, Yandex.Webmaster and Yandex.Metrica straight from Claude Code (or any MCP client). All tools are **read-only**, output is strict JSON. Not tied to a specific site: defaults (GSC property, Webmaster host, Metrica counter) are configured on the fly.

> 🛰 We use these servers in production at **[PBN Workers](https://pbn-workers.com/tools/seo-tools-mcp/)** — search-visibility infrastructure: semantic cores, PBN & satellites, SEO automation. Need steady organic traffic? [Get in touch](https://pbn-workers.com/tools/seo-tools-mcp/).

| Server | Tools | Auth |
|---|---|---|
| `xmlstock` | `xmlstock_serp`, `xmlstock_images`, `xmlstock_news`, `xmlstock_video`, `xmlstock_balance` | API key |
| `xmlriver` | `xmlriver_serp`, `xmlriver_images`, `xmlriver_news`, `xmlriver_check_index`, `xmlriver_balance` | API key |
| `wordstat` | `wordstat_frequency`, `wordstat_dynamics`, `wordstat_regions`, `wordstat_regions_tree` | Api-Key Yandex Cloud |
| `gsc` | `gsc_query`, `gsc_inspect_url`, `gsc_list_sites`, `gsc_get_site`, `gsc_list_sitemaps`, `gsc_get_sitemap` | OAuth (all account properties) / service account |
| `ywm` | `ywm_hosts`, `ywm_summary`, `ywm_search_queries`, `ywm_queries_history`, `ywm_recommended_queries`, `ywm_popular`, `ywm_indexing_history`, `ywm_sqi_history`, `ywm_external_links`, `ywm_broken_links`, `ywm_diagnostics`, `ywm_important_urls`, `ywm_sitemaps` | OAuth (auto-refresh) |
| `metrika` | `metrika_report`, `metrika_bytime`, `metrika_counters`, `metrika_goals`, `metrika_traffic_sources`, `metrika_geo`, `metrika_devices`, `metrika_landing_behavior`, `metrika_search_phrases`, `metrika_top_landings` | OAuth (auto-refresh) |

> **Regional focus:** XMLStock covers both Google and Yandex SERP, while Wordstat, Webmaster and Metrica are Yandex services — this toolkit is most useful for SEO on the Russian/CIS market (though GSC and the Google side of XMLStock are global).

Every server additionally exposes auth tools `<server>_auth_status` and `<server>_set_credentials` (see [Interactive authorization](#interactive-authorization-any-session)).

## Tools by server

### xmlstock — Google/Yandex SERP
- `xmlstock_serp` — Google/Yandex web SERP (organic + highlights + SERP features): region, device, safe search, sort (Yandex), time period, ad blocks
- `xmlstock_images` — Google image search (page url + image url + title)
- `xmlstock_news` — Google news (title, source, date, snippet)
- `xmlstock_video` — Google video (url, title, thumbnail, host, channel, duration)
- `xmlstock_balance` — account balance / key check (free)

### xmlriver — Google/Yandex SERP + indexation check
- `xmlriver_serp` — Google/Yandex organic SERP, depth in one request (groupby up to 100), AI-Overview presence flag
- `xmlriver_images` — Google image search (page url + image url + title + source + dimensions)
- `xmlriver_news` — Google news (title, source, date, snippet), time filter
- `xmlriver_check_index` — check whether a URL is indexed in Google/Yandex (`inindex`)
- `xmlriver_balance` — account balance / key check (free)

### wordstat — Yandex keyword frequencies
- `wordstat_frequency` — broad + exact frequency, refining queries (related) and associations
- `wordstat_dynamics` — frequency over time (daily/weekly/monthly)
- `wordstat_regions` — regional distribution with affinity index and resolved region names
- `wordstat_regions_tree` — full Wordstat region tree (id + name)

### gsc — Google Search Console
- `gsc_query` — Search Analytics (clicks/impressions/CTR/position), auto-pagination, `dataState` final/all
- `gsc_inspect_url` — URL Inspection: index status, coverage, canonical, last crawl, mobile usability, rich results
- `gsc_list_sites` — properties available to the authorization
- `gsc_get_site` — permission level for a property
- `gsc_list_sitemaps` — submitted sitemaps with status
- `gsc_get_sitemap` — details for one sitemap

### ywm — Yandex.Webmaster
- `ywm_hosts` — user id + verified sites
- `ywm_summary` — SQI, pages in search, excluded, site problems by severity
- `ywm_search_queries` — query analytics for a URL (~2 weeks)
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

## Quick start

### Option A — via npx (no cloning)

Each server is a self-contained npm package `seo-tools-mcp-<server>`; add it with one command:

```bash
claude mcp add xmlstock --scope user -- npx -y seo-tools-mcp-xmlstock
claude mcp add xmlriver --scope user -- npx -y seo-tools-mcp-xmlriver
claude mcp add wordstat --scope user -- npx -y seo-tools-mcp-wordstat
claude mcp add gsc      --scope user -- npx -y seo-tools-mcp-gsc
claude mcp add ywm      --scope user -- npx -y seo-tools-mcp-ywm
claude mcp add metrika  --scope user -- npx -y seo-tools-mcp-metrika
```

### Option B — from source

```bash
git clone https://github.com/antohins/seo-tools-mcp.git && cd seo-tools-mcp
pnpm install && pnpm build
ROOT=$(pwd)
for s in xmlstock xmlriver wordstat gsc ywm metrika; do
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

### Yandex OAuth (Webmaster + Metrica — one app, one token)

1. Once: https://oauth.yandex.ru/client/new → "Web services", Redirect URI: `https://oauth.yandex.ru/verification_code`. Scopes: **Yandex.Webmaster** — "Get information about sites" (`webmaster:hostinfo`) + "Manage sites" (`webmaster:verify`); **Yandex.Metrica** — "Get statistics" (`metrika:read`). Grab ClientID and Client secret.
2. Then, interactively in chat: `ywm_oauth_start` (pass ClientID + secret, they are saved) → open the link under the account that owns the site/counter → copy the code → `ywm_oauth_finish`. You get access + refresh tokens shared by ywm and metrika; **refreshed automatically**.
3. Defaults: `YWM_HOST_ID` (list — `ywm_hosts`), `METRIKA_COUNTER_ID` (list — `metrika_counters`) — set via `*_set_credentials`, or pass on each call.
4. Manual alternative: get an implicit-flow token (`response_type=token`) and store it in `YANDEX_OAUTH_TOKEN` — but without refresh it expires (Webmaster ~6 months, Metrica ~1 year).

Yandex API limitations (not server bugs): URL filtering in Webmaster exists only in query-analytics (data ~2 weeks); there is no "recommended queries" endpoint in API v4 — `ywm_recommended_queries` approximates via demand (DEMAND) + click shortfall; search phrases in Metrica are mostly "Not defined" (encrypted).

## Date format and regions

Dates — `YYYY-MM-DD` (MSK). Regions (in `xmlstock_serp`, Wordstat, etc.): a name from the built-in list of common regions ("Москва", "спб", "Казахстан"…), several comma-separated, **or** a numeric Yandex region ID (`213`, `225`…) — a numeric ID always works. Full ID directory — the `wordstat_regions_tree` tool.

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

Unit tests cover pure logic: secret masking, OAuth error classification, Metrica/GSC pagination (dedup, `truncated`), filters, the SERP parser, regions. The live smoke boots each server and calls a free tool (`xmlstock_balance`, `wordstat_frequency`, `gsc_list_sites`, `ywm_hosts`, `metrika_counters`) — an end-to-end auth check.

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
