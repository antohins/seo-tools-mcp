# seo-tools-mcp-aparser

MCP server that bridges a **self-hosted [A-Parser](https://a-parser.com) instance** to [Claude Code](https://claude.com/claude-code) and any MCP client — SERP, suggests and hundreds of parsers via A-Parser's HTTP API. Read-only, strict JSON output. Part of [seo-tools-mcp](https://github.com/antohins/seo-tools-mcp) (SEO servers for the Google/Yandex market).

> You need your **own** running A-Parser instance (licence + server). This bridge drives it; it does not host or proxy A-Parser for you.

## Install

```bash
claude mcp add aparser --scope user -- npx -y seo-tools-mcp-aparser
```

Self-contained package — the shared code is bundled in, nothing else to install. For any other MCP client (Claude Desktop, Cursor…), add one block to `mcpServers`:

```json
{
  "mcpServers": {
    "aparser": {
      "command": "npx",
      "args": ["-y", "seo-tools-mcp-aparser"],
      "env": { "APARSER_URL": "http://IP:9091/API", "APARSER_PASSWORD": "..." }
    }
  }
}
```

Then set credentials right in the chat: `aparser_auth_status` → `aparser_set_credentials`. In A-Parser: **Settings → API**, enable the API server, note the port (usually 9091) and password. Check readiness with `aparser_ping` and `aparser_status`. Full docs and all servers:
**https://github.com/antohins/seo-tools-mcp**

## Tools

- `aparser_ping` — connectivity + password check
- `aparser_status` — readiness verdict: version, installed parsers, queue, live proxies (`ready:false` if 0 live proxies)
- `aparser_proxies` — live proxies on the instance (`checkers` filters to specific proxy packs); credentials never shown
- `aparser_parsers` — parsers installed on the instance
- `aparser_parser_fields` — result fields a parser can return (flat + arrays)
- `aparser_get_preset` — read a config preset's options (useproxy, domain, hl/gl, proxy checkers…)
- `aparser_serp_google` — Google organic SERP (`SE::Google`); proxies on by default + preflight
- `aparser_serp_yandex` — Yandex organic SERP (`SE::Yandex`); region via `lr`
- `aparser_suggest` — Google/Yandex search suggestions
- `aparser_request` — universal single request to any parser (`oneRequest`)
- `aparser_bulk_request` — bulk request: one parser, many queries, N threads (`bulkRequest`)

> **Proxies.** A-Parser needs proxies + a running Proxy Checker to scrape Google/Yandex without bans. Proxy packs (proxy checkers) are configured once in the A-Parser GUI; this bridge reads, verifies and selects them (`checkers`), but does not create or load them. v1 is synchronous and read-only — the task queue and large async exports are a v2 candidate.

---

🛰 Maintained by [**PBN Workers**](https://pbn-workers.com/tools/seo-tools-mcp/) — search-visibility infrastructure: semantic cores, PBN & satellites, SEO automation. We use these tools in production. Need steady organic traffic? [Get in touch](https://pbn-workers.com/tools/seo-tools-mcp/).

MIT © antohins
