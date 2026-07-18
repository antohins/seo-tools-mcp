#!/usr/bin/env node
/**
 * xmlriver-mcp — SERP Google/Yandex через XMLRiver (xmlriver.com) для SEO-пайплайна.
 * Авторизация: env XMLRIVER_USER, XMLRIVER_KEY. Сервис ПЛАТНЫЙ за запрос —
 * число вызовов и оценка расхода логируются в stderr.
 *
 * Формат ответа — Yandex.XML (yandexsearch/response/results/grouping/group/doc),
 * тот же, что у XMLStock, поэтому парсер органики переиспользован.
 * Отличия XMLRiver, сверенные на живых ответах:
 *  - вертикали через setab=images|news (у XMLStock — tbm);
 *  - groupby РАБОТАЕТ (глубина одним запросом до 100, без принудительной пагинации);
 *  - проверка индексации URL: inindex=1 (+strict) — уникальная фича, у XMLStock её нет;
 *  - баланс: /api/get_balance/ отдаёт голое число, не JSON;
 *  - флаг AI Overview: <ai><present>1</present></ai>;
 *  - подсветок <hlword> XMLRiver не отдаёт — text_bolds будет пустым.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  accountParam,
  CostLogger,
  fetchText,
  getConfig,
  jsonResult,
  loadSharedEnv,
  registerAuthTools,
  requireEnv,
  resolveRegionId,
  safeHandler,
  sleep,
} from '@seo-tools/shared';
import { z } from 'zod';
import { parseDocs, type SerpDoc } from './parse.js';
import { parseImages, parseNews } from './verticals.js';
import { parseXml, stripTags } from './xml.js';

loadSharedEnv();

const GOOGLE_URL = 'http://xmlriver.com/search/xml';
const YANDEX_URL = 'http://xmlriver.com/search_yandex/xml';
const BALANCE_URL = 'https://xmlriver.com/api/get_balance/';

const cost = new CostLogger('xmlriver', () => Number(getConfig('XMLRIVER_PRICE_PER_CALL') || 0.02));

const DEFAULT_AGGREGATORS = 'avito.ru,cian.ru,domclick.ru,yandex.ru,m2.ru,youla.ru';
const aggregators = (): string[] =>
  (getConfig('XMLRIVER_EXCLUDE_DOMAINS') || DEFAULT_AGGREGATORS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Транзиентные коды в теле ответа (HTTP 200): «Выполните перезапрос» (500) и родственные —
// поисковая система не ответила; ретраятся. 55 — rate-limit (пауза). Ошибки не тарифицируются.
const RETRIABLE_CODES = new Set([20, 21, 22, 23, 24, 25, 101, 110, 111, 500]);
const RATE_LIMIT_CODES = new Set([55]);

/** GET к XMLRiver: строит URL, парсит XML, ретраит транзиентные коды тела (code 15 = пустая выдача). */
async function xmlriverGet(base: string, params: Record<string, string | number | undefined>, account?: string): Promise<any> {
  const user = requireEnv('XMLRIVER_USER', account);
  const key = requireEnv('XMLRIVER_KEY', account);
  const qs = new URLSearchParams({ user, key });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const url = `${base}?${qs}`;
  const engineLabel = base.includes('yandex') ? 'yandex' : 'google';
  const MAX_ATTEMPTS = 4;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // fetchText сам ретраит сетевые/5xx/429 с backoff
    const text = await fetchText(url, { timeoutMs: 90_000 });
    const doc = parseXml(text);

    const err = doc?.yandexsearch?.response?.error;
    if (!err) {
      if (!doc?.yandexsearch) {
        // не Yandex.XML (обычно HTML-страница ошибки при неверных ключах)
        throw new Error(
          'XMLRiver вернул не XML-ответ — вероятно неверные XMLRIVER_USER/XMLRIVER_KEY (xmlriver_set_credentials / xmlriver_auth_status).',
        );
      }
      cost.track(engineLabel);
      return doc;
    }

    const code = Number(err['@_code'] ?? 0);
    const message = stripTags(typeof err === 'string' ? err : (err['#text'] ?? ''));
    if (code === 15) {
      cost.track(engineLabel); // «ничего не найдено» — валидная пустая выдача, запрос тарифицирован
      return doc;
    }
    if ((RETRIABLE_CODES.has(code) || RATE_LIMIT_CODES.has(code)) && attempt < MAX_ATTEMPTS) {
      const delay = RATE_LIMIT_CODES.has(code) ? 2000 : 1500 * attempt;
      console.error(`[xmlriver] временная ошибка ${code} (${message}) — ретрай ${attempt}/${MAX_ATTEMPTS - 1} через ${delay}ms`);
      await sleep(delay);
      continue;
    }
    // коды авторизации/баланса — адресуем на ключи, а не сухой код
    if (code === 100 || code === 200 || /key|user|auth|баланс|balance|access/i.test(message)) {
      throw new Error(
        `XMLRiver error ${code}: ${message}. Проверьте XMLRIVER_USER/XMLRIVER_KEY и баланс (xmlriver_set_credentials / xmlriver_balance).`,
      );
    }
    throw new Error(`XMLRiver error ${code}: ${message}`);
  }
  throw new Error('XMLRiver: исчерпаны ретраи');
}

/** Число найденных из тела ответа. */
function extractFound(doc: any): number | null {
  const f = doc?.yandexsearch?.response?.found;
  const fv = Array.isArray(f) ? f[0] : f;
  return Number(typeof fv === 'object' ? fv?.['#text'] : fv) || null;
}

/** Флаг присутствия AI Overview (<ai><present>1</present></ai>). */
function aiPresent(doc: any): boolean {
  return String(doc?.yandexsearch?.response?.ai?.present ?? '0') === '1';
}

/** Общая часть параметров запроса. lr — id региона Яндекса (маппится и на Google). */
function commonParams(args: {
  query: string;
  region: string;
  device: string;
  searchDomain?: string;
}): Record<string, string | number | undefined> {
  const common: Record<string, string | number | undefined> = {
    query: args.query,
    device: args.device,
    domain: args.searchDomain ?? 'ru',
  };
  const lr = resolveRegionId(args.region);
  if (lr !== undefined) common.lr = lr;
  return common;
}

const server = new McpServer({ name: 'xmlriver', version: '1.0.0' });

registerAuthTools(
  server,
  'xmlriver',
  [
    { env: 'XMLRIVER_USER', label: 'ID пользователя XMLRiver (личный кабинет xmlriver.com)', secret: false },
    { env: 'XMLRIVER_KEY', label: 'API-ключ XMLRiver (личный кабинет xmlriver.com)' },
    { env: 'XMLRIVER_EXCLUDE_DOMAINS', label: 'Домены-агрегаторы для excludeAggregators, через запятую', required: false, secret: false },
  ],
  {
    help:
      '1) Регистрация на https://xmlriver.com → личный кабинет. 2) Пополнить баланс. ' +
      '3) Взять ID пользователя (user) и API-ключ (key) из кабинета. ' +
      'Проверка после сохранения — xmlriver_balance.',
  },
);

server.registerTool(
  'xmlriver_serp',
  {
    description:
      'Слепок органической выдачи Google/Yandex через XMLRiver (ПЛАТНО за запрос). ' +
      'depth собирается ОДНИМ запросом (groupby до 100). region: «Москва»/«Россия» или числовой id региона Яндекса. ' +
      'ai_overview — флаг присутствия AI Overview в выдаче Google. ' +
      'ПРИМЕЧАНИЕ: XMLRiver не отдаёт подсветки <hlword>, поэтому text_bolds всегда пуст.',
    inputSchema: {
      query: z.string().min(1),
      engine: z.enum(['google', 'yandex']).default('google'),
      device: z.enum(['desktop', 'mobile']).default('desktop'),
      region: z.string().default('Москва').describe('«Москва»/«Россия»/213/225 — id региона Яндекса (маппится и на Google)'),
      depth: z.number().int().min(1).max(100).default(10).describe('Сколько органических позиций собрать (одним запросом, groupby)'),
      excludeAggregators: z.boolean().default(false).describe('Исключить домены-агрегаторы (список — XMLRIVER_EXCLUDE_DOMAINS)'),
      includeAds: z.boolean().default(false).describe('Добавить рекламные блоки (ads=1)'),
      searchDomain: z.string().optional().describe('Доменная зона: google — ru/com/de..., yandex — ru/by/kz (по умолчанию ru)'),
      lang: z.string().optional().describe('Google hl (язык интерфейса), Yandex lang'),
      period: z.string().optional().describe('Google tbs (qdr:m, qdr:y...) / Yandex within'),
      exactQuery: z.boolean().default(false).describe('Не исправлять запрос (nfpr=1 / noreask=1)'),
      safeSearch: z.enum(['moderate', 'strict', 'off']).default('moderate').describe('Безопасный поиск'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const isGoogle = args.engine === 'google';
    const base = isGoogle ? GOOGLE_URL : YANDEX_URL;
    const common: Record<string, string | number | undefined> = {
      ...commonParams(args),
      groupby: args.depth,
    };
    if (args.includeAds) common.ads = 1;
    if (isGoogle) {
      if (args.lang) common.hl = args.lang;
      if (args.period) common.tbs = args.period;
      if (args.exactQuery) common.nfpr = 1;
      if (args.safeSearch === 'strict') common.safe = 'on';
      else if (args.safeSearch === 'off') common.safe = 'off';
    } else {
      if (args.lang) common.lang = args.lang;
      if (args.period) common.within = args.period;
      if (args.exactQuery) common.noreask = 1;
      common.filter = args.safeSearch === 'off' ? 'none' : args.safeSearch;
    }

    const doc = await xmlriverGet(base, common, args.account);
    const { docs, packs, sitelinksTop1 } = parseDocs(doc);
    let results: SerpDoc[] = docs;
    if (args.excludeAggregators) {
      const aggs = aggregators();
      results = results.filter((r) => !aggs.some((a) => r.domain === a || r.domain.endsWith(`.${a}`)));
    }
    results = results.slice(0, args.depth);
    results.forEach((r, i) => {
      r.position = i + 1;
    });

    return jsonResult({
      query: args.query,
      engine: args.engine,
      device: args.device,
      region: args.region,
      found: extractFound(doc),
      ai_overview: isGoogle ? aiPresent(doc) : false,
      count: results.length,
      results,
      serp_features: { sitelinks_top1: sitelinksTop1, packs },
    });
  }),
);

const verticalInput = {
  query: z.string().min(1),
  region: z.string().default('Москва').describe('«Москва»/«Россия»/213/225 — id региона Яндекса'),
  depth: z.number().int().min(1).max(100).default(20).describe('Сколько результатов собрать (одним запросом, groupby)'),
  device: z.enum(['desktop', 'mobile']).default('desktop'),
  searchDomain: z.string().optional().describe('Доменная зона Google (ru/com/de...), по умолчанию ru'),
  account: accountParam,
};

server.registerTool(
  'xmlriver_images',
  {
    description:
      'Поиск по картинкам Google через XMLRiver (ПЛАТНО за запрос). ' +
      'Возвращает { position, url (страница-источник), imageUrl (сама картинка), title, source, width, height }.',
    inputSchema: verticalInput,
  },
  safeHandler(async (args) => {
    const doc = await xmlriverGet(GOOGLE_URL, { ...commonParams(args), setab: 'images', groupby: args.depth }, args.account);
    const results = parseImages(doc).slice(0, args.depth);
    return jsonResult({
      query: args.query,
      vertical: 'images',
      region: args.region,
      found: extractFound(doc),
      count: results.length,
      results,
    });
  }),
);

server.registerTool(
  'xmlriver_news',
  {
    description:
      'Поиск по новостям Google через XMLRiver (ПЛАТНО за запрос). ' +
      'Возвращает { position, url, title, source (издание), date (часто относительная), snippet }. ' +
      'period — фильтр по времени (tbs, напр. qdr:d — сутки, qdr:w — неделя).',
    inputSchema: { ...verticalInput, period: z.string().optional().describe('Google tbs: qdr:h/qdr:d/qdr:w/qdr:m/qdr:y') },
  },
  safeHandler(async (args) => {
    const common: Record<string, string | number | undefined> = { ...commonParams(args), setab: 'news', groupby: args.depth };
    if (args.period) common.tbs = args.period;
    const doc = await xmlriverGet(GOOGLE_URL, common, args.account);
    const results = parseNews(doc).slice(0, args.depth);
    return jsonResult({
      query: args.query,
      vertical: 'news',
      region: args.region,
      found: extractFound(doc),
      count: results.length,
      results,
    });
  }),
);

server.registerTool(
  'xmlriver_check_index',
  {
    description:
      'Проверка индексации URL в Google/Yandex через XMLRiver (ПЛАТНО за запрос). ' +
      'Ищет точный URL в выдаче по нему же (inindex). Возвращает { url, indexed, matchedUrl, found }. ' +
      'strict=true — учитывать регистр URL.',
    inputSchema: {
      url: z.string().url().describe('Полный URL для проверки индексации'),
      engine: z.enum(['google', 'yandex']).default('google'),
      strict: z.boolean().default(false).describe('Строгое соответствие регистра URL'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const base = args.engine === 'yandex' ? YANDEX_URL : GOOGLE_URL;
    const doc = await xmlriverGet(base, { query: args.url, inindex: 1, strict: args.strict ? 1 : 0 }, args.account);
    const { docs } = parseDocs(doc);
    const norm = (u: string) => (args.strict ? u : u.toLowerCase()).replace(/\/+$/, '');
    const target = norm(args.url);
    const matched = docs.find((d) => norm(d.url) === target);
    return jsonResult({
      url: args.url,
      engine: args.engine,
      indexed: Boolean(matched),
      matchedUrl: matched?.url ?? null,
      found: extractFound(doc),
    });
  }),
);

server.registerTool(
  'xmlriver_balance',
  {
    description: 'Баланс аккаунта XMLRiver (бесплатный сервисный вызов). Заодно проверка ключей.',
    inputSchema: { account: accountParam },
  },
  safeHandler(async (args) => {
    const user = requireEnv('XMLRIVER_USER', args.account);
    const key = requireEnv('XMLRIVER_KEY', args.account);
    const url = `${BALANCE_URL}?user=${encodeURIComponent(user)}&key=${encodeURIComponent(key)}`;
    const text = (await fetchText(url, { timeoutMs: 30_000 })).trim();
    const balance = Number(text);
    if (!Number.isFinite(balance)) {
      throw new Error(
        `XMLRiver не вернул числовой баланс (получено: ${text.slice(0, 80)}) — вероятно неверные XMLRIVER_USER/XMLRIVER_KEY (xmlriver_set_credentials).`,
      );
    }
    return jsonResult({ balance });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[xmlriver] MCP-сервер запущен (stdio)');
