# seo-tools-mcp-xmlriver

MCP server for **Google & Yandex SERP via XMLRiver (read-only)** — for [Claude Code](https://claude.com/claude-code) and any MCP client. Strict JSON output. Part of [seo-tools-mcp](https://github.com/antohins/seo-tools-mcp) (SEO servers for the Google/Yandex market).

## Install

```bash
claude mcp add xmlriver --scope user -- npx -y seo-tools-mcp-xmlriver
```

Then set credentials right in the chat: `xmlriver_auth_status` → `xmlriver_set_credentials` (the agent walks you through what's needed and where to get it). Full docs, all servers and configuration:
**https://github.com/antohins/seo-tools-mcp**

## Tools

- `xmlriver_serp` — Google/Yandex organic SERP; depth in one request (groupby up to 100), AI-Overview presence flag
- `xmlriver_images` — Google image search (page url + image url + title + source + dimensions)
- `xmlriver_news` — Google news (title, source, date, snippet), time filter
- `xmlriver_check_index` — check whether a URL is indexed in Google/Yandex (`inindex`)
- `xmlriver_balance` — account balance (free) / key check

> XMLRiver is a paid SERP proxy (per request). Note: XMLRiver does not return `<hlword>` highlights, so `text_bolds` is always empty.

## Credentials

Sign up at [xmlriver.com](https://xmlriver.com), top up the balance, and take the **user ID** and **API key** from the dashboard → `XMLRIVER_USER`, `XMLRIVER_KEY`.

---

🛰 Maintained by [**Satellite1**](https://pbn-workers.com/tools/seo-tools-mcp/) — search-visibility infrastructure: semantic cores, PBN & satellites, SEO automation. We use these tools in production. Need steady organic traffic? [Get in touch](https://pbn-workers.com/tools/seo-tools-mcp/).

MIT © antohins
