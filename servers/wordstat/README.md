# seo-tools-mcp-wordstat

MCP server for **Yandex Wordstat keyword frequencies (official API v2)** — for [Claude Code](https://claude.com/claude-code) and any MCP client. Read-only, strict JSON output. Part of [seo-tools-mcp](https://github.com/antohins/seo-tools-mcp) (five SEO servers).

## Install

```bash
claude mcp add wordstat --scope user -- npx -y seo-tools-mcp-wordstat
```

Then set credentials right in the chat: `wordstat_auth_status` → `wordstat_set_credentials` (the agent walks you through what's needed and where to get it). Full docs, all five servers, multi-account and configuration:
**https://github.com/antohins/seo-tools-mcp**

## Tools

- `wordstat_frequency` — broad + exact frequency, refining queries (related) and associations
- `wordstat_dynamics` — frequency over time (daily/weekly/monthly)
- `wordstat_regions` — regional distribution with affinity index and resolved region names
- `wordstat_regions_tree` — full Wordstat region tree (id + name)

---

🛰 Maintained by [**PBN Workers**](https://pbn-workers.com/tools/seo-tools-mcp/) — search-visibility infrastructure: semantic cores, PBN & satellites, SEO automation. We use these tools in production. Need steady organic traffic? [Get in touch](https://pbn-workers.com/tools/seo-tools-mcp/).

MIT © antohins
