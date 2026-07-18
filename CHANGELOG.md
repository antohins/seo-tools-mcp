# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **New server `xmlriver`** — Google/Yandex SERP via [XMLRiver](https://xmlriver.com), a second
  SERP provider alongside XMLStock. Tools: `xmlriver_serp` (organic, depth in one request via
  `groupby`, AI-Overview presence flag), `xmlriver_images`, `xmlriver_news`, `xmlriver_check_index`
  (URL indexation check — unique to XMLRiver), `xmlriver_balance`. Verified against the live API.

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

[Unreleased]: https://github.com/antohins/seo-tools-mcp/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/antohins/seo-tools-mcp/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/antohins/seo-tools-mcp/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/antohins/seo-tools-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/antohins/seo-tools-mcp/releases/tag/v1.0.0
