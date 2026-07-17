# seo-tools-mcp-ywm

MCP server for **Yandex.Webmaster search queries (read-only)** — for [Claude Code](https://claude.com/claude-code) and any MCP client. Read-only, strict JSON output. Part of [seo-tools-mcp](https://github.com/antohins/seo-tools-mcp) (five SEO servers).

## Install

```bash
claude mcp add ywm --scope user -- npx -y seo-tools-mcp-ywm
```

Then set credentials right in the chat: `ywm_auth_status` → `ywm_set_credentials` (the agent walks you through what's needed and where to get it). Full docs, all five servers, multi-account and configuration:
**https://github.com/antohins/seo-tools-mcp**

## Tools

- `ywm_hosts`
- `ywm_search_queries`
- `ywm_recommended_queries`
- `ywm_popular`

---

🛰 Maintained by [**Satellite1**](https://satellite1.ru/) — search-visibility infrastructure: semantic cores, PBN & satellites, SEO automation. We use these tools in production. Need steady organic traffic? [Get in touch](https://satellite1.ru/).

MIT © antohins
