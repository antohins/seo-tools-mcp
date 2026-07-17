# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- npm packaging: each server ships as a self-contained package `seo-tools-mcp-<server>`
  with a `bin`, installable via `npx -y seo-tools-mcp-<server>` (shared bundled in via tsup).
- Unit tests (vitest) covering secret masking, OAuth error classification, Metrica/GSC
  pagination (dedup, `truncated`), filters, the SERP parser and regions; opt-in live smoke.
- GitHub Actions CI (build + typecheck + test) and status badge.
- English README (`README.en.md`) with a language switcher.
- Configurable `retryOn(status)` in the HTTP client.

### Changed
- HTTP retry backoff now uses full jitter to de-synchronise parallel retries.
- Yandex OAuth: refresh token is rewritten only when it actually rotates; a second 401
  right after refresh becomes an explicit "re-authorize" terminal error; `force_confirm`
  is only forced for named multi-account profiles.
- GSC: a whole-pagination deadline guards against compounding timeouts on slow endpoints.
- Yandex region directory expanded (~10 → ~55 entries) with aliases; all ids verified
  against the Wordstat region tree; any numeric id still works.

## [1.0.0] — Initial public release

### Added
- Five read-only stdio MCP servers for SEO: `xmlstock` (Google/Yandex SERP), `wordstat`,
  `gsc` (Google Search Console), `ywm` (Yandex.Webmaster), `metrika` (Yandex.Metrica).
- Single env-file config (`~/.config/seo-tools-mcp/.env`, mode 600), multi-account named
  profiles, interactive OAuth (Google, Yandex) with automatic token refresh, strict JSON output.
- Shared HTTP client with retries (429/5xx, Retry-After), secret masking in logs.

[Unreleased]: https://github.com/antohins/seo-tools-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/antohins/seo-tools-mcp/releases/tag/v1.0.0
