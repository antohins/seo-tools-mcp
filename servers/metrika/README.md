# seo-tools-mcp-metrika

MCP server for **Yandex.Metrica Stat API (read-only)** — for [Claude Code](https://claude.com/claude-code) and any MCP client. Read-only, strict JSON output. Part of [seo-tools-mcp](https://github.com/antohins/seo-tools-mcp) (five SEO servers).

## Install

```bash
claude mcp add metrika --scope user -- npx -y seo-tools-mcp-metrika
```

Then set credentials right in the chat: `metrika_auth_status` → `metrika_set_credentials` (the agent walks you through what's needed and where to get it). Full docs, all five servers, multi-account and configuration:
**https://github.com/antohins/seo-tools-mcp**

## Tools

- `metrika_counters`
- `metrika_landing_behavior`
- `metrika_search_phrases`
- `metrika_top_landings`

---

🛰 Maintained by [**Satellite1**](https://satellite1.ru/) — search-visibility infrastructure: semantic cores, PBN & satellites, SEO automation. We use these tools in production. Need steady organic traffic? [Get in touch](https://satellite1.ru/).

MIT © antohins
