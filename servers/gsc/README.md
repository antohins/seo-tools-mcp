# seo-tools-mcp-gsc

MCP server for **Google Search Console (Search Analytics, read-only)** — for [Claude Code](https://claude.com/claude-code) and any MCP client. Read-only, strict JSON output. Part of [seo-tools-mcp](https://github.com/antohins/seo-tools-mcp) (five SEO servers).

## Install

```bash
claude mcp add gsc --scope user -- npx -y seo-tools-mcp-gsc
```

Then set credentials right in the chat: `gsc_auth_status` → `gsc_set_credentials` (the agent walks you through what's needed and where to get it). Full docs, all five servers, multi-account and configuration:
**https://github.com/antohins/seo-tools-mcp**

## Tools

- `gsc_query` — Search Analytics (clicks/impressions/CTR/position), auto-pagination, `dataState` final/all
- `gsc_inspect_url` — URL Inspection: index status, coverage, canonical, last crawl, mobile usability, rich results
- `gsc_list_sites` — properties available to the authorization
- `gsc_get_site` — permission level for a property
- `gsc_list_sitemaps` — submitted sitemaps with status
- `gsc_get_sitemap` — details for one sitemap

---

🛰 Maintained by [**PBN Workers**](https://pbn-workers.com/tools/seo-tools-mcp/) — search-visibility infrastructure: semantic cores, PBN & satellites, SEO automation. We use these tools in production. Need steady organic traffic? [Get in touch](https://pbn-workers.com/tools/seo-tools-mcp/).

MIT © antohins
