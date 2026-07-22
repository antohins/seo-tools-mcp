# seo-tools-mcp-ywm

MCP server for **Yandex.Webmaster search queries (read-only)** — for [Claude Code](https://claude.com/claude-code) and any MCP client. Read-only, strict JSON output. Part of [seo-tools-mcp](https://github.com/antohins/seo-tools-mcp) (five SEO servers).

## Install

```bash
claude mcp add ywm --scope user -- npx -y seo-tools-mcp-ywm
```

Then set credentials right in the chat: `ywm_auth_status` → `ywm_set_credentials` (the agent walks you through what's needed and where to get it). Full docs, all five servers, multi-account and configuration:
**https://github.com/antohins/seo-tools-mcp**

## Tools

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

---

🛰 Maintained by [**PBN Workers**](https://pbn-workers.com/tools/seo-tools-mcp/) — search-visibility infrastructure: semantic cores, PBN & satellites, SEO automation. We use these tools in production. Need steady organic traffic? [Get in touch](https://pbn-workers.com/tools/seo-tools-mcp/).

MIT © antohins
