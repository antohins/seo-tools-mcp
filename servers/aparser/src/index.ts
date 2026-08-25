#!/usr/bin/env node
/**
 * aparser-mcp — мост к self-hosted A-Parser (https://a-parser.com/?ref=38832) через его HTTP API.
 * Авторизация: env APARSER_URL (напр. http://IP:9091/API) + APARSER_PASSWORD.
 *
 * v1 — СИНХРОННЫЙ и READ-ONLY: только читаем/диагностируем/запускаем парсинг
 * (oneRequest/bulkRequest). Настройку коробки (прокси, прокси-чекеры, пресеты)
 * НЕ трогаем — она делается в GUI один раз; мы её читаем, проверяем и выбираем.
 * Мутирующие методы (addTask/deleteTask/changeTaskStatus/…) в v1 не подключены.
 *
 * Модель прокси A-Parser: прокси → Proxy Checker (именованная «пачка», демон
 * держит alive-список) → config-пресет парсера (useproxy + какие чекеры). Выбор
 * пачки на запуск задаётся в пресете полем proxyChecker (дефолт "*" = все); per-request
 * её переопределяем через checkers. Формат/ключи override и поля serp[] сверены на
 * живом инстансе A-Parser v1.2.3527.
 *
 * Здесь — только регистрация инструментов; сеть и сборка опций — client.ts,
 * чистые парсеры ответов — parse.ts (оба покрыты юнит-тестами).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  accountParam,
  jsonResult,
  loadSharedEnv,
  registerAuthTools,
  resolveRegionId,
  safeHandler,
  withToolDefaults,
} from '@seo-tools/shared';
import { z } from 'zod';
import {
  aparserCall,
  buildOverrides,
  ensureProxies,
  getLiveProxies,
  maskPresetOptions,
  PROXY_CHECKER_OVERRIDE_ID,
  resolveExec,
} from './client.js';
import {
  allResults,
  capProxies,
  firstResult,
  type InstanceInfo,
  normalizeBulkResults,
  parseInfo,
  parseParserFields,
  parseSerpResult,
  parseSuggest,
  resultsMarker,
} from './parse.js';

loadSharedEnv();

// withToolDefaults проставляет всем инструментам readOnlyHint/openWorldHint и title
// Запуск задачи парсинга тратит ресурс пользователя — прокси-трафик и потоки его сервера.
// Денег провайдеру не платится, но ресурс метрируемый, и bulk_request легко съедает его
// целиком. Чтение конфигурации (ping/status/parsers/proxies/get_preset) — бесплатно.
const BILLED = ['aparser_serp_google', 'aparser_serp_yandex', 'aparser_suggest', 'aparser_request', 'aparser_bulk_request'];
const server = withToolDefaults(new McpServer({ name: 'aparser', version: '1.8.0' }), { billed: BILLED });

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
      'ready=false, если живых прокси 0 — SERP через прокси работать не будет: поднимите Proxy Checker в GUI ' +
      '(либо serp-инструменты допускают use_proxy=false на свой риск).',
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
      'без них — по всем пачкам. Возвращает { count, byType, truncated, proxies:[{address,type}] }: count — полное число живых, ' +
      'список обрезан до 100 (truncated=true). Логины/пароли прокси НЕ выводятся.',
    inputSchema: {
      checkers: z.array(z.string()).optional().describe('Имена прокси-пачек (proxy checkers). Пусто = все пачки.'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const view = capProxies(await getLiveProxies(args.checkers, args.account));
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
      'Помогает переиспользовать/подправить существующую настройку. preset по умолчанию — default. ' +
      'Значения чувствительных опций (pass|key|token|secret) маскируются.',
    inputSchema: {
      parser: z.string().min(1).describe('Идентификатор парсера, напр. SE::Google'),
      preset: z.string().default('default').describe('Имя пресета из GUI (по умолчанию default)'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const data = await aparserCall('getParserPreset', { parser: args.parser, preset: args.preset }, args.account);
    return jsonResult({ parser: args.parser, preset: args.preset, options: maskPresetOptions(data ?? null) });
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

server.registerTool(
  'aparser_serp_google',
  {
    description:
      'Органическая выдача Google через ваш A-Parser (парсер SE::Google, синхронно). Прокси по умолчанию включены + preflight-проверка живых прокси. ' +
      'Возвращает { serp:[{position,url,anchor,snippet,flags}], related, ads, totalcount, success, empty, results_present }. ' +
      'Смотрите success/diagnostic: success=false + diagnostic — капча или выжженные прокси (нужны свежие); ' +
      'empty=true — легитимная пустая выдача; results_present=false — битый ответ API (note с пояснением). ' +
      'Каждая страница pages — отдельный заход к поисковику: pages>1 заметно дольше и быстрее выжигает прокси.',
    inputSchema: {
      query: z.string().min(1),
      pages: z.number().int().min(1).max(10).default(1).describe('Сколько страниц выдачи собрать (каждая — отдельный заход, дольше)'),
      domain: z.string().optional().describe('Домен Google (google.com/google.ru…)'),
      hl: z.string().optional().describe('Язык интерфейса (hl)'),
      gl: z.string().optional().describe('Страна поиска (gl)'),
      ...execInput,
    },
  },
  safeHandler(async (args) => {
    const { preset, checkers, useProxy } = resolveExec(args, 'APARSER_GOOGLE_PRESET');
    await ensureProxies(useProxy, checkers, args.account);
    const options = buildOverrides({
      pagecount: args.pages,
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
    return jsonResult({ ...resultsMarker(data), ...parseSerpResult(firstResult(data)), query: args.query, engine: 'google', preset });
  }),
);

server.registerTool(
  'aparser_serp_yandex',
  {
    description:
      'Органическая выдача Яндекса через ваш A-Parser (парсер SE::Yandex, синхронно). region — «Москва»/«Россия»/213 (id региона Яндекса, lr). ' +
      'Прокси по умолчанию включены + preflight. Возвращает { serp:[{position,url,anchor,snippet}], related, ads, totalcount, success, empty, results_present }. ' +
      'Смотрите success/diagnostic: success=false + diagnostic — капча или выжженные прокси; empty=true — легитимная пустая выдача; ' +
      'results_present=false — битый ответ API (note с пояснением). pages>1 — дольше и быстрее выжигает прокси.',
    inputSchema: {
      query: z.string().min(1),
      pages: z.number().int().min(1).max(10).default(1),
      region: z.string().default('Москва').describe('«Москва»/«Россия»/213 — id региона Яндекса (lr)'),
      ...execInput,
    },
  },
  safeHandler(async (args) => {
    const { preset, checkers, useProxy } = resolveExec(args, 'APARSER_YANDEX_PRESET');
    await ensureProxies(useProxy, checkers, args.account);
    const lr = resolveRegionId(args.region);
    const options = buildOverrides({
      pagecount: args.pages,
      lr: lr,
      useproxy: useProxy,
      [PROXY_CHECKER_OVERRIDE_ID]: checkers ? checkers.join(',') : undefined,
    });
    const data = await aparserCall(
      'oneRequest',
      { parser: 'SE::Yandex', preset, query: args.query, rawResults: 1, doLog: 0, options },
      args.account,
    );
    return jsonResult({
      ...resultsMarker(data),
      ...parseSerpResult(firstResult(data)),
      query: args.query,
      engine: 'yandex',
      region: args.region,
      preset,
    });
  }),
);

server.registerTool(
  'aparser_suggest',
  {
    description:
      'Поисковые подсказки Google/Яндекса через A-Parser (парсеры SE::Google::Suggest / SE::Yandex::Suggest). Возвращает список фраз. ' +
      'Прокси по умолчанию включены + preflight-проверка живых прокси (suggest тоже банится без них). ' +
      'results_present=false — API вернул success без results (битый ответ, НЕ пустой список подсказок; см. note).',
    inputSchema: {
      query: z.string().min(1),
      engine: z.enum(['google', 'yandex']).default('yandex'),
      ...execInput,
    },
  },
  safeHandler(async (args) => {
    const parser = args.engine === 'google' ? 'SE::Google::Suggest' : 'SE::Yandex::Suggest';
    const { preset, checkers, useProxy } = resolveExec(args, args.engine === 'google' ? 'APARSER_GOOGLE_PRESET' : 'APARSER_YANDEX_PRESET');
    await ensureProxies(useProxy, checkers, args.account);
    const options = buildOverrides({ useproxy: useProxy, [PROXY_CHECKER_OVERRIDE_ID]: checkers ? checkers.join(',') : undefined });
    const data = await aparserCall('oneRequest', { parser, preset, query: args.query, rawResults: 1, doLog: 0, options }, args.account);
    const suggestions = parseSuggest(firstResult(data));
    return jsonResult({ ...resultsMarker(data), query: args.query, engine: args.engine, count: suggestions.length, suggestions });
  }),
);

server.registerTool(
  'aparser_request',
  {
    description:
      'Универсальный синхронный запрос к любому парсеру A-Parser (метод oneRequest). Для парсеров, под которые нет типизированного инструмента. ' +
      'options — массив override-опций A-Parser (как есть). raw=true (по умолчанию) → структурированный результат; false → форматированная строка пресета. ' +
      'Env-дефолты serp-инструментов (APARSER_*_PRESET, APARSER_PROXY_CHECKERS, APARSER_USE_PROXY) тут НЕ действуют — ' +
      'пресет и опции задаются только параметрами вызова. results_present=false (raw=true) — API вернул success без results (битый ответ, см. note). ' +
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
    return jsonResult({
      ...(args.raw ? resultsMarker(data) : {}),
      parser: args.parser,
      query: args.query,
      preset: args.preset,
      raw: args.raw,
      result,
    });
  }),
);

server.registerTool(
  'aparser_bulk_request',
  {
    description:
      'Пакетный синхронный запрос: один парсер, много запросов в несколько потоков (метод bulkRequest). Синхронно — держите объём разумным (лимит 200 запросов). ' +
      'Один HTTP-вызов до 120 с БЕЗ ретраев: при таймауте уменьшите число queries или threads и повторите — сам запрос при этом мог выполниться на инстансе. ' +
      'raw=true: для SE::Google/SE::Yandex результаты нормализуются ({ serp, related, ads, success, … }), для остальных парсеров отдаются как есть; ' +
      'raw=false — resultString пресета. count < requested — часть запросов не выполнена (см. note в ответе). ' +
      'Для больших выгрузок нужна очередь задач (кандидат в v2).',
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
    // тяжёлый синхронный bulk не ретраим: повтор удвоил бы нагрузку на инстанс и прокси
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
      { attempts: 1, timeoutMs: 120_000 },
    );
    const results = allResults(data);
    return jsonResult({
      parser: args.parser,
      requested: args.queries.length,
      count: results.length,
      ...(results.length < args.queries.length
        ? {
            note: `A-Parser вернул результатов меньше, чем запрошено (${results.length} из ${args.queries.length}) — часть запросов не выполнена (капчи/прокси/таймаут).`,
          }
        : {}),
      results: normalizeBulkResults(args.parser, results, args.raw),
    });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[aparser] MCP-сервер запущен (stdio)');
