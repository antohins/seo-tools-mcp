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
- `ga4_metadata` — dimensions and metrics available in **this** property, custom definitions included (`customEvent:…`); substring search, plus `blockedReasons` (a blocked metric returns zeros with no error) and `type` (int vs float for `metricFilters`)
- `ga4_check_compatibility` — whether a dimension/metric combination works in this property, without spending a heavy report; on failure it names the fields GA4 wants removed, and it also lists what else can be added
- `ga4_report` — arbitrary report: any dimensions × metrics, dimension **and metric** filters, sorting, period comparison and totals (full Data API `runReport`)
- `ga4_bytime` — metrics over time (date / hour / week / month)
- `ga4_traffic_sources` — sessions/users by channel group, source-medium, source, medium or campaign; `organicOnly` for SEO
- `ga4_geo` — country / region / city
- `ga4_devices` — device category / OS / browser
- `ga4_top_pages` — top pages by path, landing page or title; `organicOnly` + `pathContains` filters
- `ga4_events` — event counts by `eventName`; `keyEventsOnly` for key events (former conversions)
- `ga4_realtime` — realtime report (last 30 minutes)
- `ga4_funnel` — funnel (`runFunnelReport`): how many reached each step and where they dropped off; a step is an event and/or dimension conditions, with an optional breakdown. Steps follow the Exploration API schema (`pagePath` is unavailable there), the quota bucket is separate and a call costs more than a plain report
- `ga4_annotations` — property annotations: notes pinned to dates, including ones GA4 generated itself (`systemGenerated`) — often the explanation for an unexplained jump in a trend
- `ga4_property_details` — property card: reporting time zone, currency, service level (STANDARD/360) and data streams with their `G-XXXXXXX` Measurement IDs

> **Period comparison and totals.** Every report tool accepts `compareStartDate`/`compareEndDate` (rows then carry a `dateRange` column valued `current`/`previous`) and `includeTotals` (a `totals` field, one row per period when comparing). Note that GA4's `limit` applies to the **whole** response, not per period — when comparing, raise it (roughly double) so both periods get their rows; the response says so explicitly when it matters.

> **Units and dates.** GA4 returns `bounceRate`/`engagementRate` as a **fraction (0..1)**, not a percent. Dates are resolved in the **property's timezone** — pass `YYYY-MM-DD` or GA4 keywords (`today`, `yesterday`, `28daysAgo`); the applied timezone comes back in the response. Responses also carry `totalRows`/`truncated` and `thresholded: true` when GA4 hides part of the data behind its privacy threshold.

---

🛰 Maintained by [**PBN Workers**](https://pbn-workers.com/tools/seo-tools-mcp/) — search-visibility infrastructure: semantic cores, PBN & satellites, SEO automation. We use these tools in production. Need steady organic traffic? [Get in touch](https://pbn-workers.com/tools/seo-tools-mcp/).

MIT © antohins
