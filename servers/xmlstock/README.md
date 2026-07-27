# seo-tools-mcp-xmlstock

MCP server for **Google & Yandex SERP + Yandex Wordstat via XMLStock** — for [Claude Code](https://claude.com/claude-code) and any MCP client. Read-only, strict JSON output. Part of [seo-tools-mcp](https://github.com/antohins/seo-tools-mcp) (SEO servers for the Google/Yandex market).

## Install

```bash
claude mcp add xmlstock --scope user -- npx -y seo-tools-mcp-xmlstock
```

Then set credentials right in the chat: `xmlstock_auth_status` → `xmlstock_set_credentials` (the agent walks you through what's needed and where to get it). Full docs, all five servers, multi-account and configuration:
**https://github.com/antohins/seo-tools-mcp**

## Tools

- `xmlstock_serp` — Google/Yandex web SERP (organic + highlights + SERP features), region, device, safe search, sort (Yandex), time period, ad blocks
- `xmlstock_images` — Google image search (page url + image url + title)
- `xmlstock_news` — Google news (title, source, date, snippet)
- `xmlstock_video` — Google video (url, title, thumbnail, host, channel, duration)
- `xmlstock_wordstat` — Yandex Wordstat: top + related queries with frequency (region-scoped)
- `xmlstock_wordstat_dynamics` — Wordstat frequency over time (day/week/month)
- `xmlstock_wordstat_regions` — Wordstat demand by region (count, share, affinity index + region names)
- `xmlstock_wordstat_regions_tree` — Wordstat region tree (id + name + path)
- `xmlstock_balance` — account balance / key check (free)

> Wordstat via XMLStock uses the same `XMLSTOCK_*` key as SERP — no separate Yandex Cloud setup needed (unlike the standalone `wordstat` server).

---

🛰 Maintained by [**PBN Workers**](https://pbn-workers.com/tools/seo-tools-mcp/) — search-visibility infrastructure: semantic cores, PBN & satellites, SEO automation. We use these tools in production. Need steady organic traffic? [Get in touch](https://pbn-workers.com/tools/seo-tools-mcp/).

MIT © antohins
