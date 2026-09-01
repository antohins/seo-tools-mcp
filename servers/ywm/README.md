# seo-tools-mcp-ywm

[![GitHub MCP Registry](https://img.shields.io/badge/GitHub%20MCP%20Registry-listed-24292e?logo=github)](https://github.com/mcp/antohins/seo-tools-mcp-ywm)

MCP server for **Yandex.Webmaster search queries (read-only)** — for [Claude Code](https://claude.com/claude-code) and any MCP client. Read-only, strict JSON output. Part of [seo-tools-mcp](https://github.com/antohins/seo-tools-mcp) (eight SEO servers).

## Install

```bash
claude mcp add ywm --scope user -- npx -y seo-tools-mcp-ywm
```

Self-contained package — the shared code is bundled in, nothing else to install. For any other MCP client (Claude Desktop, Cursor…), add one block to `mcpServers`:

```json
{
  "mcpServers": {
    "ywm": {
      "command": "npx",
      "args": ["-y", "seo-tools-mcp-ywm"]
    }
  }
}
```

Yandex.Webmaster uses Yandex OAuth — no env needed to start; authorize right in the chat via `ywm_auth_status` → `ywm_oauth_start` / `ywm_oauth_finish` (token auto-refreshes). Full docs, all eight servers, multi-account and configuration:
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
