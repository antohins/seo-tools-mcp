# seo-tools-mcp-metrika

MCP server for **Yandex.Metrica Stat API (read-only)** — for [Claude Code](https://claude.com/claude-code) and any MCP client. Read-only, strict JSON output. Part of [seo-tools-mcp](https://github.com/antohins/seo-tools-mcp) (five SEO servers).

## Install

```bash
claude mcp add metrika --scope user -- npx -y seo-tools-mcp-metrika
```

Then set credentials right in the chat: `metrika_auth_status` → `metrika_set_credentials` (the agent walks you through what's needed and where to get it). Full docs, all five servers, multi-account and configuration:
**https://github.com/antohins/seo-tools-mcp**

## Tools

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

---

🛰 Maintained by [**PBN Workers**](https://pbn-workers.com/tools/seo-tools-mcp/) — search-visibility infrastructure: semantic cores, PBN & satellites, SEO automation. We use these tools in production. Need steady organic traffic? [Get in touch](https://pbn-workers.com/tools/seo-tools-mcp/).

MIT © antohins
