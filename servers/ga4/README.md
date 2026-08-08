# seo-tools-mcp-ga4

MCP server for **Google Analytics 4** — for [Claude Code](https://claude.com/claude-code) and any MCP client. Read-only, strict JSON output. Part of [seo-tools-mcp](https://github.com/antohins/seo-tools-mcp) (SEO servers for the Google/Yandex market).

## Install

```bash
claude mcp add ga4 --scope user -- npx -y seo-tools-mcp-ga4
```

Self-contained package — the shared code is bundled in, nothing else to install. For any other MCP client (Claude Desktop, Cursor…), add one block to `mcpServers`:

```json
{
  "mcpServers": {
    "ga4": {
      "command": "npx",
      "args": ["-y", "seo-tools-mcp-ga4"]
    }
  }
}
```

GA4 uses Google OAuth — no env needed to start; authorize right in the chat via `ga4_auth_status` → `ga4_oauth_start` / `ga4_oauth_finish` (or a service-account JSON). If you already authorized the `gsc` server, the same `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are reused — GA4 only needs its own consent (different scope). Full docs, all eight servers, multi-account and configuration:
**https://github.com/antohins/seo-tools-mcp**

## Tools

- `ga4_list_properties` — GA4 properties available to the authorization (this is where you get `propertyId` — it is **not** the `G-XXXXXXX` Measurement ID)
- `ga4_report` — arbitrary report: any dimensions × metrics, dimension filters, sorting (full Data API `runReport`)
- `ga4_bytime` — metrics over time (date / hour / week / month)
- `ga4_traffic_sources` — sessions/users by channel group, source-medium, source, medium or campaign; `organicOnly` for SEO
- `ga4_geo` — country / region / city
- `ga4_devices` — device category / OS / browser
- `ga4_top_pages` — top pages by path, landing page or title; `organicOnly` + `pathContains` filters
- `ga4_events` — event counts by `eventName`; `keyEventsOnly` for key events (former conversions)
- `ga4_realtime` — realtime report (last 30 minutes)

> **Units and dates.** GA4 returns `bounceRate`/`engagementRate` as a **fraction (0..1)**, not a percent. Dates are resolved in the **property's timezone** — pass `YYYY-MM-DD` or GA4 keywords (`today`, `yesterday`, `28daysAgo`); the applied timezone comes back in the response. Responses also carry `totalRows`/`truncated` and `thresholded: true` when GA4 hides part of the data behind its privacy threshold.

---

🛰 Maintained by [**PBN Workers**](https://pbn-workers.com/tools/seo-tools-mcp/) — search-visibility infrastructure: semantic cores, PBN & satellites, SEO automation. We use these tools in production. Need steady organic traffic? [Get in touch](https://pbn-workers.com/tools/seo-tools-mcp/).

MIT © antohins
