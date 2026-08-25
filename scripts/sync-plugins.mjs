#!/usr/bin/env node
/**
 * Единственный источник правды для маркетплейса плагинов Claude Code.
 *
 * Из спеки ниже генерируются `.claude-plugin/marketplace.json` и всё содержимое
 * `plugins/`: манифесты, `.mcp.json` и копии навыков. Навыки приходится именно
 * КОПИРОВАТЬ: Claude Code отвергает `skills`-путь, выходящий за каталог плагина
 * (`../../skills/...` → «Validation errors: skills: Invalid input»), а один навык
 * нужен нескольким плагинам. Правится всегда `skills/<name>/SKILL.md`, копии —
 * машинные.
 *
 * Без аргументов — проверка (падает на расхождении), `--write` — запись.
 * В CI стоит проверка: расхождение означает, что кто-то правил копию, а не оригинал.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const AUTHOR = { name: 'antohins', url: 'https://github.com/antohins' };
const HOME = 'https://github.com/antohins/seo-tools-mcp';
const s = (title, description, opts = {}) => ({ type: 'string', title, description, ...opts });

/** Один сервер = один плагин: ставится только нужное, а не сотня инструментов сразу. */
const SERVERS = [
  {
    id: 'xmlstock',
    displayName: 'SEO Tools: XMLStock (SERP + Wordstat)',
    description:
      'Google & Yandex SERP plus Yandex Wordstat via XMLStock: positions, competitors, snippets, keyword frequencies. Read-only.',
    keywords: ['seo', 'serp', 'google', 'yandex', 'wordstat', 'xmlstock', 'rank-tracking'],
    skills: ['serp-rank-tracking', 'keyword-research-ru'],
    userConfig: {
      XMLSTOCK_USER: s('XMLStock user ID', 'Numeric user ID from your XMLStock dashboard (xmlstock.com).'),
      XMLSTOCK_KEY: s('XMLStock API key', 'API key from the same dashboard.', { sensitive: true }),
    },
  },
  {
    id: 'xmlriver',
    displayName: 'SEO Tools: XMLRiver (SERP + indexation)',
    description:
      'Google & Yandex SERP, image/news/maps verticals, People Also Ask and URL indexation checks via XMLRiver. Read-only.',
    keywords: ['seo', 'serp', 'google', 'yandex', 'xmlriver', 'indexation', 'rank-tracking'],
    skills: ['serp-rank-tracking'],
    userConfig: {
      XMLRIVER_USER: s('XMLRiver user ID', 'Numeric user ID from your XMLRiver dashboard (xmlriver.com).'),
      XMLRIVER_KEY: s('XMLRiver API key', 'API key from the same dashboard.', { sensitive: true }),
    },
  },
  {
    id: 'wordstat',
    displayName: 'SEO Tools: Yandex Wordstat',
    description:
      'Keyword frequencies, seasonality and regional breakdown from the official Yandex Wordstat API v2. Free tier, read-only.',
    keywords: ['seo', 'wordstat', 'yandex', 'keyword-research', 'search-volume'],
    skills: ['keyword-research-ru'],
    userConfig: {
      WORDSTAT_API_KEY: s(
        'Yandex Cloud API key',
        'Service-account API key with scope yc.search-api.execute (console.yandex.cloud).',
        { sensitive: true },
      ),
      WORDSTAT_FOLDER_ID: s('Yandex Cloud folder ID', 'Folder that owns the service account.'),
    },
  },
  {
    id: 'gsc',
    displayName: 'SEO Tools: Google Search Console',
    description:
      'Search Analytics, URL Inspection and sitemaps from Google Search Console. Read-only; run gsc_oauth_start after install to authorise.',
    keywords: ['seo', 'google-search-console', 'gsc', 'search-analytics', 'url-inspection'],
    skills: ['gsc-search-analytics'],
    userConfig: {
      GOOGLE_CLIENT_ID: s(
        'Google OAuth client ID',
        'Desktop-app OAuth client from console.cloud.google.com. Shared with the ga4 plugin.',
      ),
      GOOGLE_CLIENT_SECRET: s('Google OAuth client secret', 'Secret of the same OAuth client.', { sensitive: true }),
      GSC_SITE_URL: s('Default property', 'e.g. sc-domain:example.com — otherwise pass siteUrl on every call.'),
    },
  },
  {
    id: 'ga4',
    displayName: 'SEO Tools: Google Analytics 4',
    description:
      'GA4 reports, traffic sources, landing pages, events, funnels, annotations and realtime. Read-only; run ga4_oauth_start after install to authorise.',
    keywords: ['seo', 'google-analytics', 'ga4', 'analytics', 'reporting'],
    skills: ['ga4-reporting'],
    userConfig: {
      GOOGLE_CLIENT_ID: s(
        'Google OAuth client ID',
        'Desktop-app OAuth client from console.cloud.google.com. Shared with the gsc plugin.',
      ),
      GOOGLE_CLIENT_SECRET: s('Google OAuth client secret', 'Secret of the same OAuth client.', { sensitive: true }),
      GA4_PROPERTY_ID: s(
        'Default property ID',
        'Numeric GA4 property id (not the G-XXXXXXX measurement ID) — see ga4_list_properties.',
      ),
    },
  },
  {
    id: 'ywm',
    displayName: 'SEO Tools: Yandex.Webmaster',
    description:
      'Search queries, indexing history, SQI, diagnostics and broken links from Yandex.Webmaster. Read-only; run ywm_oauth_start after install.',
    keywords: ['seo', 'yandex', 'webmaster', 'indexing', 'search-queries'],
    skills: ['yandex-webmaster-metrika'],
    userConfig: {
      YANDEX_CLIENT_ID: s('Yandex OAuth app ID', 'OAuth app from oauth.yandex.ru. Shared with the metrika plugin.'),
      YANDEX_CLIENT_SECRET: s('Yandex OAuth app secret', 'Secret of the same OAuth app.', { sensitive: true }),
      YWM_HOST_ID: s('Default host', 'Webmaster host id, format https:example.com:443 — see ywm_hosts.'),
    },
  },
  {
    id: 'metrika',
    displayName: 'SEO Tools: Yandex.Metrica',
    description:
      'Traffic sources, landing pages, search phrases, goals, geo and devices from the Yandex.Metrica Stat API. Read-only; run metrika_oauth_start after install.',
    keywords: ['seo', 'yandex', 'metrica', 'metrika', 'analytics', 'reporting'],
    skills: ['yandex-webmaster-metrika'],
    userConfig: {
      YANDEX_CLIENT_ID: s('Yandex OAuth app ID', 'OAuth app from oauth.yandex.ru. Shared with the ywm plugin.'),
      YANDEX_CLIENT_SECRET: s('Yandex OAuth app secret', 'Secret of the same OAuth app.', { sensitive: true }),
      METRIKA_COUNTER_ID: s('Default counter ID', 'Numeric counter id — see metrika_counters.'),
    },
  },
  {
    id: 'aparser',
    displayName: 'SEO Tools: A-Parser bridge',
    description:
      'Bridge to your own self-hosted A-Parser: SERP, suggests and 150+ parsers via its HTTP API. Read-only; needs your own A-Parser licence and server.',
    keywords: ['seo', 'a-parser', 'aparser', 'serp', 'scraping', 'self-hosted'],
    skills: ['aparser-operations', 'serp-rank-tracking'],
    userConfig: {
      APARSER_URL: s(
        'A-Parser API endpoint',
        'Full URL including the path, e.g. http://IP:9091/API (A-Parser → Settings → API).',
      ),
      APARSER_PASSWORD: s('A-Parser API password', 'Password from the same settings page.', { sensitive: true }),
    },
  },
];

const BUNDLE = {
  id: 'seo-tools',
  displayName: 'SEO Tools: everything',
  description:
    'All eight servers at once: XMLStock, XMLRiver, Wordstat, Search Console, Analytics 4, Yandex.Webmaster, Yandex.Metrica and the A-Parser bridge. ~100 tools — prefer the single-server plugins unless you need the lot.',
  keywords: ['seo', 'serp', 'google', 'yandex', 'analytics', 'search-console', 'wordstat', 'a-parser'],
  // бандл получает все навыки: он и есть «всё сразу»
  skills: [...new Set(SERVERS.flatMap((srv) => srv.skills))].sort(),
};

const mcpEntry = (id) => ({ command: 'npx', args: ['-y', `seo-tools-mcp-${id}`] });

/** Собранное дерево: путь относительно корня → содержимое файла. */
const expected = new Map();
const put = (path, content) => expected.set(path, content);
const putJson = (path, json) => put(path, `${JSON.stringify(json, null, 2)}\n`);

const manifest = (plugin, extra) => ({
  $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
  name: plugin.id,
  displayName: plugin.displayName,
  version: VERSION,
  description: plugin.description,
  author: AUTHOR,
  homepage: extra.homepage,
  repository: HOME,
  license: 'MIT',
  keywords: plugin.keywords,
  ...(plugin.userConfig ? { userConfig: plugin.userConfig } : {}),
});

for (const srv of SERVERS) {
  putJson(
    `plugins/${srv.id}/.claude-plugin/plugin.json`,
    manifest(srv, { homepage: `${HOME}/tree/main/servers/${srv.id}#readme` }),
  );
  // mcpServers держим в отдельном .mcp.json, а не inline в манифесте: при inline-форме
  // `claude plugin details` показывает «MCP servers (0)» — для плагина, который ЕСТЬ
  // mcp-сервер, это враньё в самом заметном месте каталога.
  putJson(`plugins/${srv.id}/.mcp.json`, {
    mcpServers: {
      [srv.id]: {
        ...mcpEntry(srv.id),
        env: Object.fromEntries(Object.keys(srv.userConfig).map((k) => [k, `\${user_config.${k}}`])),
      },
    },
  });
}

// Бандл без userConfig: ключей было бы 19 и диалог установки стал бы нечитаем;
// каждый сервер настраивается своим <server>_set_credentials прямо в чате.
putJson(`plugins/${BUNDLE.id}/.claude-plugin/plugin.json`, manifest(BUNDLE, { homepage: `${HOME}#readme` }));
putJson(`plugins/${BUNDLE.id}/.mcp.json`, {
  mcpServers: Object.fromEntries(SERVERS.map((srv) => [srv.id, mcpEntry(srv.id)])),
});

for (const plugin of [...SERVERS, BUNDLE]) {
  for (const skill of plugin.skills) {
    const src = join(ROOT, 'skills', skill, 'SKILL.md');
    if (!existsSync(src)) {
      console.error(`Навык ${skill} указан у плагина ${plugin.id}, но skills/${skill}/SKILL.md не существует.`);
      process.exit(1);
    }
    put(`plugins/${plugin.id}/skills/${skill}/SKILL.md`, readFileSync(src, 'utf8'));
  }
}

putJson('.claude-plugin/marketplace.json', {
  $schema: 'https://json.schemastore.org/claude-code-marketplace.json',
  name: 'seo-tools-mcp',
  owner: { name: 'antohins', url: HOME },
  description: 'Read-only MCP servers for SEO on the Google/Yandex (RU/CIS) market — one plugin per data source.',
  metadata: { pluginRoot: './plugins' },
  plugins: [...SERVERS, BUNDLE].map((p) => ({
    name: p.id,
    source: `./plugins/${p.id}`,
    description: p.description,
    category: p.id === 'ga4' || p.id === 'metrika' ? 'analytics' : 'seo',
    keywords: p.keywords,
  })),
});

/** Всё, что реально лежит в plugins/ — чтобы поймать осиротевшие файлы. */
const onDisk = [];
const walk = (abs) => {
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs)) {
    const full = join(abs, entry);
    if (statSync(full).isDirectory()) walk(full);
    else onDisk.push(relative(ROOT, full));
  }
};
walk(join(ROOT, 'plugins'));

const stale = onDisk.filter((p) => !expected.has(p)).sort();
const drift = [];

for (const [path, content] of expected) {
  const abs = join(ROOT, path);
  const actual = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  if (actual === content) continue;
  drift.push(`${actual === null ? 'нет файла' : 'расходится'}: ${path}`);
  if (WRITE) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

if (WRITE) {
  for (const path of stale) rmSync(join(ROOT, path));
  const touched = drift.length + stale.length;
  console.log(
    touched
      ? `Перегенерировано под ${VERSION}: файлов ${drift.length}, удалено лишних ${stale.length}.`
      : `Плагины уже синхронны: ${expected.size} файлов, плагинов ${SERVERS.length + 1}.`,
  );
  process.exit(0);
}

if (drift.length || stale.length) {
  console.error(
    `Каталог plugins/ разошёлся со спекой (scripts/sync-plugins.mjs):\n  ${[
      ...drift,
      ...stale.map((p) => `лишний файл: ${p}`),
    ].join('\n  ')}\n\nПравить надо спеку и skills/<name>/SKILL.md, копии перегенерировать: pnpm plugins:sync`,
  );
  process.exit(1);
}

console.log(`Плагины синхронны: ${expected.size} файлов, плагинов ${SERVERS.length + 1}.`);
