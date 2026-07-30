#!/usr/bin/env node
/**
 * aparser-mcp — мост к self-hosted A-Parser (a-parser.com) через его HTTP API.
 * Авторизация: env APARSER_URL (напр. http://IP:9091/API) + APARSER_PASSWORD.
 *
 * v1 — СИНХРОННЫЙ и READ-ONLY: только читаем/диагностируем/запускаем парсинг
 * (oneRequest/bulkRequest). Настройку коробки (прокси, прокси-чекеры, пресеты)
 * НЕ трогаем — она делается в GUI один раз; мы её читаем, проверяем и выбираем.
 * Мутирующие методы (addTask/deleteTask/changeTaskStatus/…) в v1 не подключены.
 *
 * Модель прокси A-Parser: прокси → Proxy Checker (именованная «пачка», демон
 * держит alive-список) → config-пресет парсера (useproxy + какие чекеры). Выбор
 * пачки на запуск задаётся в пресете; per-request её можно указать через checkers
 * (проверяется getProxies, прокидывается в override). Точный override-ключ и имена
 * полей serp[] подтверждаются на живом инстансе — изолированы в build-хелперах ниже.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  accountParam,
  fetchText,
  getConfig,
  jsonResult,
  loadSharedEnv,
  registerAuthTools,
  requireEnv,
  resolveRegionId,
  safeHandler,
} from '@seo-tools/shared';
import { z } from 'zod';
import {
  allResults,
  firstResult,
  type InstanceInfo,
  type ProxiesView,
  parseInfo,
  parseParserFields,
  parseProxies,
  parseSerpResult,
  parseSuggest,
} from './parse.js';

loadSharedEnv();

/**
 * LIVE-VERIFY: точный id override-ключа выбора прокси-чекера в options.
 * Подтвердить через aparser_get_preset на реальном инстансе (в пресете есть поле
 * «Use proxy checkers»). Правится в одном месте.
 */
const PROXY_CHECKER_OVERRIDE_ID = 'proxychecker';

/** POST к A-Parser API: {action,password,data}; success!==1 → осмысленная ошибка. */
async function aparserCall(action: string, data: Record<string, unknown>, account?: string): Promise<any> {
  const base = requireEnv('APARSER_URL', account);
  const password = requireEnv('APARSER_PASSWORD', account);
  const payload: Record<string, unknown> = { action, password };
  if (data && Object.keys(data).length) payload.data = data;

  const text = await fetchText(base, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    body: JSON.stringify(payload),
    timeoutMs: 120_000,
  });

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `A-Parser вернул не JSON (${text.slice(0, 120)}). Проверьте APARSER_URL — он должен указывать на эндпоинт …/API, а API-сервер быть включён (Settings → API). aparser_auth_status.`,
    );
  }
  if (!json || json.success !== 1) {
    const msg = String((json && (json.msg || json.message || (json.data && json.data.msg))) || 'неизвестная ошибка');
    if (/pass|denied|access|auth|доступ|парол/i.test(msg)) {
      throw new Error(`A-Parser: доступ отклонён (${msg}). Проверьте APARSER_PASSWORD (aparser_set_credentials).`);
    }
    throw new Error(`A-Parser error: ${msg}`);
  }
  return json.data;
}

/** Дефолтные прокси-пачки из env (APARSER_PROXY_CHECKERS="a,b"). */
function defaultCheckers(account?: string): string[] | undefined {
  const v = getConfig('APARSER_PROXY_CHECKERS', account);
  if (!v) return undefined;
  const list = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

/** Дефолт use_proxy (APARSER_USE_PROXY), по умолчанию true. */
function defaultUseProxy(account?: string): boolean {
  const v = getConfig('APARSER_USE_PROXY', account);
  if (v == null || v === '') return true;
  return /^(1|true|yes|on)$/i.test(v);
}

/** Живые прокси инстанса (опц. только указанных пачек). */
async function getLiveProxies(checkers: string[] | undefined, account?: string): Promise<ProxiesView> {
  const data = await aparserCall('getProxies', checkers && checkers.length ? { checkers } : {}, account);
  return parseProxies(data);
}

/**
 * Сборка override-опций A-Parser (формат элемента — {type:'override',id,value}).
 * Пропускает undefined. useproxy и выбор прокси-чекера включены сюда.
 */
function buildOverrides(
  map: Record<string, string | number | boolean | undefined>,
): Array<{ type: 'override'; id: string; value: string }> {
  const out: Array<{ type: 'override'; id: string; value: string }> = [];
  for (const [id, value] of Object.entries(map)) {
    if (value === undefined || value === '') continue;
    out.push({ type: 'override', id, value: typeof value === 'boolean' ? (value ? '1' : '0') : String(value) });
  }
  return out;
}

/** Preflight для SERP: при use_proxy проверяем, что в выбранных пачках есть живые прокси. */
async function ensureProxies(useProxy: boolean, checkers: string[] | undefined, account?: string): Promise<void> {
  if (!useProxy) return;
  const { count } = await getLiveProxies(checkers, account);
  if (count === 0) {
    const where = checkers && checkers.length ? `в пачках [${checkers.join(', ')}]` : 'ни в одной пачке';
    throw new Error(
      `A-Parser: живых прокси ${where} нет — SERP по Google/Яндексу почти наверняка забанится. ` +
        `Загрузите прокси и запустите Proxy Checker в GUI, либо укажите use_proxy=false на свой риск. aparser_proxies — текущее состояние.`,
    );
  }
}

const server = new McpServer({ name: 'aparser', version: '1.0.0' });

registerAuthTools(
  server,
  'aparser',
  [
    { env: 'APARSER_URL', label: 'URL API вашего A-Parser, напр. http://IP:9091/API (Settings → API)', secret: false },
    { env: 'APARSER_PASSWORD', label: 'Пароль API A-Parser (Settings → API)' },
    { env: 'APARSER_GOOGLE_PRESET', label: 'Пресет по умолчанию для SE::Google (имя из GUI)', required: false, secret: false },
    { env: 'APARSER_YANDEX_PRESET', label: 'Пресет по умолчанию для SE::Yandex', required: false, secret: false },
    { env: 'APARSER_PROXY_CHECKERS', label: 'Прокси-пачки по умолчанию (имена чекеров, через запятую)', required: false, secret: false },
    { env: 'APARSER_USE_PROXY', label: 'Использовать прокси по умолчанию (true/false)', required: false, secret: false },
  ],
  {
    help:
      '1) В A-Parser: Settings → API — включить API-сервер, запомнить порт (обычно 9091) и пароль. ' +
      '2) APARSER_URL = http://<IP-инстанса>:<порт>/API. 3) APARSER_PASSWORD = пароль оттуда же. ' +
      'Проверка после сохранения — aparser_ping и aparser_status. ' +
      'Прокси и прокси-чекеры настраиваются в GUI A-Parser (мы их не создаём, только читаем/выбираем).',
  },
);

server.registerTool(
  'aparser_ping',
  {
    description: 'Проверка связи с A-Parser и пароля API (метод ping). Быстрый способ убедиться, что инстанс доступен.',
    inputSchema: { account: accountParam },
  },
  safeHandler(async (args) => {
    await aparserCall('ping', {}, args.account);
    return jsonResult({ ok: true });
  }),
);

server.registerTool(
  'aparser_status',
  {
    description:
      'Вердикт готовности A-Parser: версия, число установленных парсеров, очередь/потоки (info) + суммарно живых прокси (getProxies). ' +
      'ready=false, если живых прокси 0 — SERP работать не будет, нужно поднять Proxy Checker в GUI.',
    inputSchema: { account: accountParam },
  },
  safeHandler(async (args) => {
    const info: InstanceInfo = parseInfo(await aparserCall('info', {}, args.account));
    let liveProxies = 0;
    let proxiesError: string | null = null;
    try {
      liveProxies = (await getLiveProxies(undefined, args.account)).count;
    } catch (e) {
      proxiesError = e instanceof Error ? e.message : String(e);
    }
    return jsonResult({
      ready: liveProxies > 0,
      version: info.version,
      parsersInstalled: info.parsersCount,
      liveProxies,
      proxiesError,
      queue: { tasksInQueue: info.tasksInQueue, workingTasks: info.workingTasks, activeThreads: info.activeThreads },
    });
  }),
);

server.registerTool(
  'aparser_proxies',
  {
    description:
      'Живые (проверенные) прокси на инстансе A-Parser (метод getProxies). checkers — имена прокси-пачек (proxy checkers); ' +
      'без них — по всем пачкам. Возвращает { count, byType, proxies:[{address,type}] }. Логины/пароли прокси НЕ выводятся.',
    inputSchema: {
      checkers: z.array(z.string()).optional().describe('Имена прокси-пачек (proxy checkers). Пусто = все пачки.'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const view = await getLiveProxies(args.checkers, args.account);
    return jsonResult({ checkers: args.checkers ?? null, ...view });
  }),
);

server.registerTool(
  'aparser_parsers',
  {
    description:
      'Список парсеров, установленных на инстансе A-Parser (из метода info). Полезно перед aparser_request/aparser_parser_fields.',
    inputSchema: { account: accountParam },
  },
  safeHandler(async (args) => {
    const info = parseInfo(await aparserCall('info', {}, args.account));
    return jsonResult({ count: info.parsersCount, parsers: info.parsers });
  }),
);

server.registerTool(
  'aparser_parser_fields',
  {
    description:
      'Какие поля результата умеет вернуть парсер (метод getParserInfo): flat-поля (напр. query) и array-поля (напр. serp, ads, related). ' +
      'Используйте, чтобы понять структуру перед aparser_request с произвольным парсером.',
    inputSchema: {
      parser: z.string().min(1).describe('Идентификатор парсера, напр. SE::Google, SE::Yandex::Wordstat, Net::HTTP'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const data = await aparserCall('getParserInfo', { parser: args.parser }, args.account);
    return jsonResult({ parser: args.parser, ...parseParserFields(data) });
  }),
);

server.registerTool(
  'aparser_get_preset',
  {
    description:
      'Прочитать опции готового config-пресета парсера (метод getParserPreset): useproxy, домен, hl/gl, device, выбор прокси-чекеров и т.д. ' +
      'Помогает переиспользовать/подправить существующую настройку. preset по умолчанию — default.',
    inputSchema: {
      parser: z.string().min(1).describe('Идентификатор парсера, напр. SE::Google'),
      preset: z.string().default('default').describe('Имя пресета из GUI (по умолчанию default)'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const data = await aparserCall('getParserPreset', { parser: args.parser, preset: args.preset }, args.account);
    return jsonResult({ parser: args.parser, preset: args.preset, options: data ?? null });
  }),
);

/** Общие параметры выбора пресета/прокси для execute-инструментов. */
const execInput = {
  preset: z.string().optional().describe('Имя config-пресета из GUI (по умолчанию — из env APARSER_*_PRESET или default)'),
  checkers: z
    .array(z.string())
    .optional()
    .describe('Прокси-пачки (proxy checkers) на этот запрос; переопределяет пресет (по умолчанию — env APARSER_PROXY_CHECKERS)'),
  use_proxy: z.boolean().optional().describe('Использовать прокси (по умолчанию — env APARSER_USE_PROXY, обычно true)'),
  account: accountParam,
};

/** Разрешить пресет/пачки/use_proxy из аргументов с фолбэком на env-дефолты. */
function resolveExec(args: any, presetEnv: string): { preset: string; checkers: string[] | undefined; useProxy: boolean } {
  const preset = args.preset || getConfig(presetEnv, args.account) || 'default';
  const checkers = args.checkers && args.checkers.length ? args.checkers : defaultCheckers(args.account);
  const useProxy = args.use_proxy ?? defaultUseProxy(args.account);
  return { preset, checkers, useProxy };
}

server.registerTool(
  'aparser_serp_google',
  {
    description:
      'Органическая выдача Google через ваш A-Parser (парсер SE::Google, синхронно). Прокси по умолчанию включены + preflight-проверка живых прокси. ' +
      'Возвращает { serp:[{position,url,anchor,snippet,flags}], related, ads, totalcount }.',
    inputSchema: {
      query: z.string().min(1),
      pages: z.number().int().min(1).max(10).default(1).describe('Сколько страниц выдачи собрать'),
      domain: z.string().optional().describe('Домен Google (google.com/google.ru…)'),
      hl: z.string().optional().describe('Язык интерфейса (hl)'),
      gl: z.string().optional().describe('Страна поиска (gl)'),
      device: z.enum(['desktop', 'mobile']).default('desktop'),
      ...execInput,
    },
  },
  safeHandler(async (args) => {
    const { preset, checkers, useProxy } = resolveExec(args, 'APARSER_GOOGLE_PRESET');
    await ensureProxies(useProxy, checkers, args.account);
    const options = buildOverrides({
      pagecount: args.pages,
      device: args.device,
      domain: args.domain,
      hl: args.hl,
      gl: args.gl,
      useproxy: useProxy,
      [PROXY_CHECKER_OVERRIDE_ID]: checkers ? checkers.join(',') : undefined,
    });
    const data = await aparserCall(
      'oneRequest',
      { parser: 'SE::Google', preset, query: args.query, rawResults: 1, doLog: 0, options },
      args.account,
    );
    return jsonResult({ ...parseSerpResult(firstResult(data)), query: args.query, engine: 'google', preset });
  }),
);

server.registerTool(
  'aparser_serp_yandex',
  {
    description:
      'Органическая выдача Яндекса через ваш A-Parser (парсер SE::Yandex, синхронно). region — «Москва»/«Россия»/213 (id региона Яндекса, lr). ' +
      'Прокси по умолчанию включены + preflight. Возвращает { serp:[{position,url,anchor,snippet}], related, totalcount }.',
    inputSchema: {
      query: z.string().min(1),
      pages: z.number().int().min(1).max(10).default(1),
      region: z.string().default('Москва').describe('«Москва»/«Россия»/213 — id региона Яндекса (lr)'),
      device: z.enum(['desktop', 'mobile']).default('desktop'),
      ...execInput,
    },
  },
  safeHandler(async (args) => {
    const { preset, checkers, useProxy } = resolveExec(args, 'APARSER_YANDEX_PRESET');
    await ensureProxies(useProxy, checkers, args.account);
    const lr = resolveRegionId(args.region);
    const options = buildOverrides({
      pagecount: args.pages,
      device: args.device,
      lr: lr,
      useproxy: useProxy,
      [PROXY_CHECKER_OVERRIDE_ID]: checkers ? checkers.join(',') : undefined,
    });
    const data = await aparserCall(
      'oneRequest',
      { parser: 'SE::Yandex', preset, query: args.query, rawResults: 1, doLog: 0, options },
      args.account,
    );
    return jsonResult({ ...parseSerpResult(firstResult(data)), query: args.query, engine: 'yandex', region: args.region, preset });
  }),
);

server.registerTool(
  'aparser_suggest',
  {
    description:
      'Поисковые подсказки Google/Яндекса через A-Parser (парсеры SE::Google::Suggest / SE::Yandex::Suggest). Возвращает список фраз.',
    inputSchema: {
      query: z.string().min(1),
      engine: z.enum(['google', 'yandex']).default('yandex'),
      ...execInput,
    },
  },
  safeHandler(async (args) => {
    const parser = args.engine === 'google' ? 'SE::Google::Suggest' : 'SE::Yandex::Suggest';
    const { preset, checkers, useProxy } = resolveExec(args, args.engine === 'google' ? 'APARSER_GOOGLE_PRESET' : 'APARSER_YANDEX_PRESET');
    const options = buildOverrides({ useproxy: useProxy, [PROXY_CHECKER_OVERRIDE_ID]: checkers ? checkers.join(',') : undefined });
    const data = await aparserCall('oneRequest', { parser, preset, query: args.query, rawResults: 1, doLog: 0, options }, args.account);
    const suggestions = parseSuggest(firstResult(data));
    return jsonResult({ query: args.query, engine: args.engine, count: suggestions.length, suggestions });
  }),
);

server.registerTool(
  'aparser_request',
  {
    description:
      'Универсальный синхронный запрос к любому парсеру A-Parser (метод oneRequest). Для парсеров, под которые нет типизированного инструмента. ' +
      'options — массив override-опций A-Parser (как есть). raw=true (по умолчанию) → структурированный результат; false → форматированная строка пресета. ' +
      'Структуру полей парсера смотрите через aparser_parser_fields.',
    inputSchema: {
      parser: z.string().min(1).describe('Идентификатор парсера, напр. SE::Yandex::Wordstat, Net::HTTP, SE::Bing'),
      query: z.string().min(1),
      preset: z.string().default('default'),
      raw: z.boolean().default(true).describe('true → structured results; false → resultString пресета'),
      options: z.array(z.any()).optional().describe('Override-опции A-Parser (массив), прокидываются как есть'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const data = await aparserCall(
      'oneRequest',
      {
        parser: args.parser,
        preset: args.preset,
        query: args.query,
        rawResults: args.raw ? 1 : 0,
        doLog: 0,
        ...(args.options ? { options: args.options } : {}),
      },
      args.account,
    );
    const result = args.raw ? firstResult(data) : (data?.resultString ?? null);
    return jsonResult({ parser: args.parser, query: args.query, preset: args.preset, raw: args.raw, result });
  }),
);

server.registerTool(
  'aparser_bulk_request',
  {
    description:
      'Пакетный синхронный запрос: один парсер, много запросов в несколько потоков (метод bulkRequest). Синхронно — держите объём разумным (лимит 200 запросов). ' +
      'Для больших выгрузок нужна очередь задач (кандидат в v2). Возвращает результаты по каждому запросу.',
    inputSchema: {
      parser: z.string().min(1),
      queries: z.array(z.string().min(1)).min(1).max(200).describe('Список запросов (до 200 за вызов)'),
      preset: z.string().default('default'),
      threads: z.number().int().min(1).max(50).default(5),
      raw: z.boolean().default(true),
      options: z.array(z.any()).optional().describe('Override-опции A-Parser (массив), прокидываются как есть'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const data = await aparserCall(
      'bulkRequest',
      {
        parser: args.parser,
        preset: args.preset,
        queries: args.queries,
        threads: args.threads,
        rawResults: args.raw ? 1 : 0,
        doLog: 0,
        ...(args.options ? { options: args.options } : {}),
      },
      args.account,
    );
    const results = allResults(data);
    return jsonResult({
      parser: args.parser,
      requested: args.queries.length,
      count: results.length,
      results: args.raw ? results.map((r) => parseSerpResult(r)) : results,
    });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[aparser] MCP-сервер запущен (stdio)');
