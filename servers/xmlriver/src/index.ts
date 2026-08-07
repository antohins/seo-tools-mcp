#!/usr/bin/env node
/**
 * xmlriver-mcp — SERP Google/Yandex через XMLRiver (xmlriver.com) для SEO-пайплайна.
 * Авторизация: env XMLRIVER_USER, XMLRIVER_KEY. Сервис ПЛАТНЫЙ за запрос —
 * число вызовов и оценка расхода логируются в stderr.
 *
 * Формат ответа — Yandex.XML (yandexsearch/response/results/grouping/group/doc),
 * тот же, что у XMLStock, поэтому парсер органики переиспользован.
 * Отличия XMLRiver, сверенные на живых ответах (2026-07):
 *  - вертикали через setab=images|news (у XMLStock — tbm);
 *  - groupby ИГНОРИРУЕТСЯ (всегда 10/страницу): глубина добирается пагинацией
 *    (Google page с 1, Яндекс page с 0), каждая страница — отдельный платный запрос;
 *  - проверка индексации URL: inindex=1 (+strict) — работает и для Яндекса;
 *  - баланс: /api/get_balance/ отдаёт голое число, не JSON;
 *  - флаг AI Overview: <ai><present>1</present></ai> (приходит и без ai=1);
 *    полный обзор (includeAIOverview → ai=1: <ai><answer> = base64 HTML, текст + ссылки)
 *    — ПЛАТНЫЙ параметр (доп. тарификация XMLRiver, замедляет выдачу), только Google;
 *  - подсветок <hlword> XMLRiver не отдаёт (highlights=1 проверен лайвом — пусто),
 *    text_bolds будет пустым;
 *  - подсказки Google (xmlriver_suggest): POST setab=tips с JSON-телом {"phrases":[...]}
 *    (1–50 фраз), ответ — плоский {"phrases":[...]}, ~10 подсказок на фразу в порядке входа;
 *    ПЛАТНО за КАЖДУЮ фразу;
 *  - «Вопросы по теме» Google / People Also Ask (xmlriver_related_questions): GET setab=rq,
 *    count ОБЯЗАТЕЛЕН (без него ошибка 15), макс. 50. Вопросы (question) парсятся всегда;
 *    title/snippet/url ПУСТЫЕ, пока в кабинете XMLRiver не включена платная опция
 *    «Related Questions с ответами». Нет PAA-блока → код 15 (тарифицируется, empty: true);
 *  - гео-таргетинг Google (xmlriver_serp/xmlriver_suggest/xmlriver_images/xmlriver_news,
 *    лайв 2026-08): location (город →
 *    loc, Google criteria ID — работает: 1011969 Москва / 1012040 СПб дают разную выдачу) и
 *    country (числовой id страны, RU=2643); country автовыводится из города, явный перекрывает.
 *    Резолв города — через справочник geo.csv (~5 МБ, скачивается раз, кэш на диске
 *    ~/.config/seo-tools-mcp/cache/, TTL 7 дней), маппинги стран/доменов — ./data.js
 *    (см. ./geo.js). Яндексу loc/country НЕ шлём (его гео — region/lr);
 *  - устройства: device — desktop/mobile/tablet; os (ios/android) по доке работает ТОЛЬКО
 *    при device=mobile — для остальных device параметр не отправляется;
 *  - поиск заведений по Google Maps (xmlriver_maps): GET setab=maps с обязательными zoom (1–15)
 *    и coords (lat,lng), опциональные count (5–50) и lr; ответ — <maps><item>
 *    (разбор — ./maps.js). ВАЖНО: формат по доке, лайвом НЕ подтверждён — на тестовом
 *    аккаунте (2026-08) эндпоинт стабильно отвечает кодом 500 (обычный SERP работает):
 *    вероятно, нужна платная опция кабинета;
 *  - доп. SERP-блоки Google (xmlriver_serp, includeAdditional → additional=knowledge_graph,...):
 *    блоки приходят в <response><addresults> (knowledge_graph — плоские поля + отзывы/события,
 *    localresultsplace — карточки карт, rs → relatedSearches — связанные запросы); наполнение
 *    зависит от ПЛАТНЫХ опций кабинета XMLRiver и наличия блока в выдаче (лайв 2026-08: KG
 *    пришёл с пустыми полями, остальное не пришло вовсе) — непришедшие перечисляются
 *    в unavailable. Только Google, параметр шлётся на первой странице пагинации
 *    (разбор — ./additional.js).
 * HTTP-слой SERP и хелперы выдачи — в ./serp.js (там же ретраи и учёт расхода),
 * сбор подсказок — в ./suggest.js, сбор «Вопросов по теме» — в ./related.js,
 * поиск заведений по картам — в ./maps.js.
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
  safeHandler,
} from '@seo-tools/shared';
import { z } from 'zod';
import { ADDITIONAL_PARAMS } from './additional.js';
import { resolveGeo } from './geo.js';
import { collectMaps, mapsCoordsSchema } from './maps.js';
import { collectRelatedQuestions } from './related.js';
import { buildSerpParams, buildVerticalParams, checkIndex, collectSerp, collectVertical, GOOGLE_URL, YANDEX_URL } from './serp.js';
import { collectSuggest, suggestPhrasesSchema } from './suggest.js';
import { parseImages, parseNews } from './verticals.js';

loadSharedEnv();

const BALANCE_URL = 'https://xmlriver.com/api/get_balance/';

const DEFAULT_AGGREGATORS = 'avito.ru,cian.ru,domclick.ru,yandex.ru,m2.ru,youla.ru';
const aggregators = (): string[] =>
  (getConfig('XMLRIVER_EXCLUDE_DOMAINS') || DEFAULT_AGGREGATORS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const server = new McpServer({ name: 'xmlriver', version: '1.4.0' });

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

// Один регион: SERP XMLRiver принимает единственный lr (список не поддерживается)
const serpRegionParam = z
  .string()
  .default('Москва')
  .describe(
    '«Москва»/«Россия»/213/225 — ОДИН регион (название или id Яндекса, lr). Шлётся только Яндексу; органика Google гео-инвариантна, lr для Google не отправляется.',
  );

// Гео-таргетинг Google: location (город → loc) + country (ISO/id → числовой id XMLRiver).
// Общие описания для xmlriver_serp и xmlriver_suggest.
const geoLocationParam = (scope: string) =>
  z
    .string()
    .min(1)
    .optional()
    .describe(
      `Локальная выдача Google по городу (${scope}): название на английском («Moscow», «Saint Petersburg») или числовой Google criteria ID ` +
        '(«1011969»). Резолвится в параметр loc; при первом использовании скачивается справочник geo.csv XMLRiver (~5 МБ, кэш на диске 7 дней). ' +
        'Страна выводится из города автоматически',
    );
const geoCountryParam = (scope: string) =>
  z
    .string()
    .min(1)
    .optional()
    .describe(
      `Страна выдачи Google (${scope}): ISO-код («RU», «US») или числовой id XMLRiver («2643»). ` +
        'Без location — задаёт страну отдельно; с location — перекрывает автовыведенную из города',
    );

// device: desktop/mobile/tablet. os (ios/android) по доке работает ТОЛЬКО при device=mobile —
// для остальных device параметр в API не отправляется (см. buildSerpParams/buildVerticalParams).
const deviceParam = z.enum(['desktop', 'mobile', 'tablet']).default('desktop');
const osParam = z
  .enum(['ios', 'android'])
  .optional()
  .describe('ОС устройства: отправляется ТОЛЬКО при device=mobile (по доке os работает только с mobile); для desktop/tablet игнорируется');

server.registerTool(
  'xmlriver_serp',
  {
    description:
      'Слепок органической выдачи Google/Yandex через XMLRiver (ПЛАТНО: каждые 10 результатов = 1 платный запрос, ' +
      'depth добирается пагинацией). Возвращает { found, truncated (true = выдача кончилась раньше depth), ' +
      'ai_overview: { present } — флаг присутствия AI Overview у Google; при includeAIOverview=true — ' +
      '{ present, available, text?, links? } (полный текст AIO и цитируемые ссылки, ПЛАТНО — ai=1), ' +
      'results: [{ position, url, title, snippet, text_bolds }], serp_features: { sitelinks_top1, packs } }. ' +
      'includeAdditional (только Google) — доп. SERP-блоки из <addresults> в поле additional: knowledge_graph, local_results, ' +
      'related_searches, faq, для прочих — { present: true }; наполнение зависит от платных опций кабинета XMLRiver и наличия ' +
      'блока в выдаче, непришедшие — в additional.unavailable. ' +
      'Пустая выдача (код 15) ТАРИФИЦИРУЕТСЯ и помечается { results: [], empty: true, note }. ' +
      'Гео-таргетинг Google (engine=google): location — локальная выдача по городу («Moscow»/«1011969» → loc), ' +
      'country — страна («RU»/«2643», автовыводится из города); применённое гео эхом возвращается в поле geo. ' +
      'ПРИМЕЧАНИЕ: подсветки <hlword> XMLRiver не отдаёт (проверено лайвом 2026-07), text_bolds всегда пуст.',
    inputSchema: {
      query: z.string().min(1),
      engine: z.enum(['google', 'yandex']).default('google'),
      device: deviceParam,
      os: osParam,
      region: serpRegionParam,
      location: geoLocationParam('только engine=google; для yandex игнорируется — гео Яндекса задаётся region/lr'),
      country: geoCountryParam('только engine=google; для yandex игнорируется'),
      depth: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe('Сколько органических позиций собрать; добирается пагинацией — каждые 10 результатов = 1 платный запрос'),
      excludeAggregators: z
        .boolean()
        .default(false)
        .describe(
          'Исключить домены-агрегаторы из органики (список — XMLRIVER_EXCLUDE_DOMAINS, дефолт: avito/cian/domclick/yandex/m2/youla)',
        ),
      includeAds: z
        .boolean()
        .default(false)
        .describe('Добавить рекламные блоки (ads=1): реклама включается в ответ API и отражается строками в packs, отдельной секции нет'),
      includeAIOverview: z
        .boolean()
        .default(false)
        .describe(
          'ПЛАТНО (доп. тарификация XMLRiver), замедляет выдачу: полный текст Обзора от ИИ + цитируемые ссылки (ai=1). ' +
            'Только engine=google; для yandex параметр игнорируется и ai=1 не отправляется',
        ),
      includeAdditional: z
        .array(z.enum(ADDITIONAL_PARAMS))
        .optional()
        .describe(
          'Дополнительные SERP-блоки Google (additional=, только engine=google; для yandex игнорируется): ' +
            'knowledge_graph — карточка знаний (поля, отзывы, события), localresultsplace — карточки карт (local_results), ' +
            'rs — связанные запросы (related_searches), faqsnippet — FAQ (faq), остальные — флаг присутствия { present: true }. ' +
            'ВАЖНО: наполнение блоков зависит от платных опций кабинета XMLRiver («Платные дополнительные параметры») и наличия ' +
            'блока в выдаче; запрошенные, но не пришедшие блоки перечисляются в additional.unavailable. Шлётся только на первой странице',
        ),
      searchDomain: z
        .string()
        .regex(/^[a-z]{2,3}(\.[a-z]{2,3})?$/)
        .optional()
        .describe('Доменная зона: google — ru/com/de... (маппится в числовой id домена, ru → 143), yandex — ru/by/kz (по умолчанию ru)'),
      lang: z
        .string()
        .regex(/^[a-z]{2}(-[a-zA-Z]{2,4})?$/)
        .optional()
        .describe('Google hl (язык интерфейса), Yandex lang'),
      period: z.string().optional().describe('Google tbs (qdr:m, qdr:y...) / Yandex within (77=сутки, 1=2 недели, 2=месяц)'),
      exactQuery: z.boolean().default(false).describe('Не исправлять запрос (nfpr=1 / noreask=1)'),
      safeSearch: z
        .enum(['moderate', 'strict', 'off'])
        .default('moderate')
        .describe(
          'Безопасный поиск — применяется ТОЛЬКО к Google: moderate = дефолт Google (размытие, параметр НЕ шлётся), ' +
            'strict = safe=on, off = safe=off. Для engine=yandex параметр не отправляется вовсе ' +
            '(у XMLRiver Яндекс filter — «скрывать похожие результаты», другая семантика)',
        ),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const isGoogle = args.engine === 'google';
    const base = isGoogle ? GOOGLE_URL : YANDEX_URL;

    // Гео-таргетинг Google: location → loc (+ автовывод country из города), явный country
    // перекрывает автовывод. Для yandex не применяется — там гео задаёт region/lr.
    const geo = isGoogle ? await resolveGeo(args.location, args.country) : undefined;

    // ai=1 — только Google и только на первой странице (реализовано внутри collectSerp)
    const wantAio = isGoogle && args.includeAIOverview;
    // additional= — тоже только Google и только первая страница; для yandex молча игнорируем
    const wantAdditional = isGoogle ? args.includeAdditional : undefined;
    // args.country — строка из схемы, в params уходит число из geo (или undefined)
    const collected = await collectSerp(
      base,
      buildSerpParams({ ...args, loc: geo?.loc, country: geo?.country }),
      args.depth,
      args.account,
      wantAio,
      wantAdditional,
    );
    let results = collected.results;
    if (args.excludeAggregators) {
      const aggs = aggregators();
      results = results.filter((r) => !aggs.some((a) => r.domain === a || r.domain.endsWith(`.${a}`)));
      results.forEach((r, i) => {
        r.position = i + 1;
      });
    }

    return jsonResult({
      query: args.query,
      engine: args.engine,
      device: args.device,
      region: args.region,
      ...(geo ? { geo } : {}),
      found: collected.found,
      truncated: collected.truncated,
      ai_overview: isGoogle ? (wantAio ? collected.aiOverview : { present: collected.ai }) : false,
      // доп. SERP-блоки Google (additional=) — только когда запрошены
      ...(collected.additional ? { additional: collected.additional } : {}),
      // код 15 — пустая выдача: деньги списаны, явно помечаем, чтобы не путать с «нет данных»
      ...(collected.empty ? { empty: true, note: 'пустая выдача (код 15), запрос тарифицирован' } : {}),
      count: results.length,
      results,
      serp_features: { sitelinks_top1: collected.sitelinksTop1, packs: collected.packs },
    });
  }),
);

const verticalInput = {
  query: z.string().min(1),
  region: z
    .string()
    .default('Москва')
    .describe(
      '«Москва»/«Россия»/213/225 — принимается для совместимости; вертикали — только Google, выдача гео-инвариантна, lr не отправляется',
    ),
  depth: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Сколько результатов собрать; пагинация — каждые ~10 результатов = 1 платный запрос'),
  device: deviceParam,
  os: osParam,
  location: geoLocationParam('вертикали Google-only, гейта по engine нет'),
  country: geoCountryParam('вертикали Google-only'),
  searchDomain: z
    .string()
    .regex(/^[a-z]{2,3}(\.[a-z]{2,3})?$/)
    .optional()
    .describe('Доменная зона Google (ru/com/de...), по умолчанию ru'),
  account: accountParam,
};

server.registerTool(
  'xmlriver_images',
  {
    description:
      'Поиск по картинкам Google через XMLRiver (ПЛАТНО: каждые ~10 результатов = 1 платный запрос, пагинация). ' +
      'Возвращает { position, url (страница-источник), imageUrl (сама картинка), title, source, width, height }. ' +
      'Гео-таргетинг: location (город → loc, «Moscow»/«1011969») и country («RU»/«2643», автовыводится из города); ' +
      'применённое гео эхом возвращается в поле geo. truncated: true = выдача кончилась раньше запрошенного depth.',
    inputSchema: verticalInput,
  },
  safeHandler(async (args) => {
    const geo = await resolveGeo(args.location, args.country);
    const common = { ...buildVerticalParams({ ...args, loc: geo?.loc, country: geo?.country }), setab: 'images' };
    const { results, found, empty, truncated } = await collectVertical(common, args.depth, parseImages, args.account);
    return jsonResult({
      query: args.query,
      vertical: 'images',
      region: args.region,
      ...(geo ? { geo } : {}),
      found,
      truncated,
      ...(empty ? { empty: true, note: 'пустая выдача (код 15), запрос тарифицирован' } : {}),
      count: results.length,
      results,
    });
  }),
);

server.registerTool(
  'xmlriver_news',
  {
    description:
      'Поиск по новостям Google через XMLRiver (ПЛАТНО: каждые ~10 результатов = 1 платный запрос, пагинация). ' +
      'Возвращает { position, url, title, source (издание), date (часто относительная), snippet }. ' +
      'Гео-таргетинг: location (город → loc, «Moscow»/«1011969») и country («RU»/«2643», автовыводится из города); ' +
      'применённое гео эхом возвращается в поле geo. truncated: true = выдача кончилась раньше запрошенного depth. period — фильтр по времени (tbs).',
    inputSchema: { ...verticalInput, period: z.string().optional().describe('Google tbs: qdr:h/qdr:d/qdr:w/qdr:m/qdr:y') },
  },
  safeHandler(async (args) => {
    const geo = await resolveGeo(args.location, args.country);
    const common: Record<string, string | number | undefined> = {
      ...buildVerticalParams({ ...args, loc: geo?.loc, country: geo?.country }),
      setab: 'news',
    };
    if (args.period) common.tbs = args.period;
    const { results, found, empty, truncated } = await collectVertical(common, args.depth, parseNews, args.account);
    return jsonResult({
      query: args.query,
      vertical: 'news',
      region: args.region,
      ...(geo ? { geo } : {}),
      found,
      truncated,
      ...(empty ? { empty: true, note: 'пустая выдача (код 15), запрос тарифицирован' } : {}),
      count: results.length,
      results,
    });
  }),
);

server.registerTool(
  'xmlriver_check_index',
  {
    description:
      'Проверка индексации URL в Google/Яндексе через XMLRiver (ПЛАТНО за запрос). ' +
      'Ищет точный URL в выдаче по нему же (inindex). Возвращает { url, engine, indexed, matchedUrl, found }. ' +
      'strict=true — учитывать регистр URL.',
    inputSchema: {
      url: z
        .string()
        .url()
        .max(1400, 'XMLRiver ограничивает query 1400 символами (иначе ошибка 16 API) — сократите URL')
        .describe('Полный URL для проверки индексации (до 1400 символов)'),
      engine: z.enum(['google', 'yandex']).default('google').describe('Поисковая система для проверки (inindex работает у обеих)'),
      strict: z.boolean().default(false).describe('Строгое соответствие регистра URL'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => jsonResult(await checkIndex(args.url, args.engine, args.strict, args.account))),
);

server.registerTool(
  'xmlriver_suggest',
  {
    description:
      'Поисковые подсказки Google через XMLRiver (setab=tips). ПЛАТНО за КАЖДУЮ фразу: N фраз = N списаний, до 50 фраз за вызов. ' +
      'Возвращает { phrases: string[] — плоский список в порядке входных фраз (~10 подсказок на фразу), ' +
      'byPhrase: Record<фраза, string[]> — группировка по входным фразам, если подсказок поровну на фразу (иначе null + note), ' +
      'count, charged (число тарифицированных фраз) }. Гео подсказок: location (город → loc, «Moscow»/«1011969») и country («RU»/«2643») — ' +
      'применённое гео эхом возвращается в поле geo.',
    inputSchema: {
      phrases: suggestPhrasesSchema.describe('Фразы для сбора подсказок (1–50; ПЛАТНО за каждую: N фраз = N списаний)'),
      region: z
        .string()
        .optional()
        .describe('«Москва»/«Россия»/213/225 — ОДИН регион подсказок (название или id Яндекса, lr); без него — без гео'),
      location: geoLocationParam('подсказки'),
      country: geoCountryParam('подсказки'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    // гео Google-подсказок: location → loc (+ автовывод country), явный country перекрывает
    const geo = await resolveGeo(args.location, args.country);
    const result = await collectSuggest(args.phrases, args.region, args.account, geo);
    return jsonResult({ ...result, ...(geo ? { geo } : {}) });
  }),
);

server.registerTool(
  'xmlriver_related_questions',
  {
    description:
      'Блок «Вопросы по теме» (People Also Ask) Google через XMLRiver (setab=rq, ПЛАТНО за запрос). ' +
      'Возвращает { questions: [{ question, title?, snippet?, url? }], count, answers_available, empty?, note? }. ' +
      'ВАЖНО: title/snippet/url (ответы на вопросы) заполняются только при включённой платной опции ' +
      '«Related Questions с ответами» в кабинете XMLRiver (настройки сбора); иначе они пустые ' +
      '(answers_available: false + note), сами вопросы доступны всегда. ' +
      'Отсутствие PAA-блока по запросу (код 15) ТАРИФИЦИРУЕТСЯ и помечается { questions: [], empty: true, note }.',
    inputSchema: {
      query: z.string().min(1),
      count: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Сколько вопросов собрать; count — обязательный параметр API XMLRiver (без него ошибка 15), максимум 50'),
      region: z.string().optional().describe('«Москва»/«Россия»/213/225 — ОДИН регион (название или id Яндекса, lr); без него — без гео'),
      device: deviceParam,
      os: osParam,
      account: accountParam,
    },
  },
  safeHandler(async (args) =>
    jsonResult(await collectRelatedQuestions(args.query, args.count, args.region, args.device, args.os, args.account)),
  ),
);

server.registerTool(
  'xmlriver_maps',
  {
    description:
      'Поиск заведений по Google Maps через XMLRiver (setab=maps, ПЛАТНО за запрос). ' +
      'Обязательные query + coords (широта,долгота) + zoom (1–15); count (5–50) — сколько заведений вернуть. ' +
      'Возвращает { places: [{ title, stars?, type?, address?, url?, phone?, review?, features? (сервисы заведения), ' +
      'lat, lng, place_id?, reviews_count?, accessibility?, price? }], count, found, empty? }. ' +
      'Пустая выдача (код 15) ТАРИФИЦИРУЕТСЯ и помечается { places: [], empty: true, note }. ' +
      'ВАЖНО: формат ответа — по доке XMLRiver, лайвом не подтверждён (на тестовом аккаунте эндпоинт устойчиво ' +
      'отвечает кодом 500 — вероятно, требуется платная опция кабинета XMLRiver).',
    inputSchema: {
      query: z.string().min(1).describe('Что ищем на картах («кафе», «стоматология»…)'),
      coords: mapsCoordsSchema.describe('Координаты центра поиска: «широта,долгота», например «51.5468,45.9968»'),
      zoom: z.number().int().min(1).max(15).describe('Масштаб карты (1–15), обязательный параметр API'),
      count: z.number().int().min(5).max(50).default(20).describe('Сколько заведений вернуть (5–50)'),
      region: z.string().optional().describe('«Москва»/«Россия»/213/225 — ОДИН регион (название или id Яндекса, lr); без него — без гео'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => jsonResult(await collectMaps(args.query, args.coords, args.zoom, args.count, args.region, args.account))),
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
    const raw = await fetchText(url, { timeoutMs: 30_000 });
    // терпим BOM/пробелы и десятичную запятую; НЕ вычищаем символы агрессивно,
    // чтобы HTML-страница ошибки честно превратилась в NaN, а не в мусорное число
    const text = raw.replace(/^﻿/, '').trim().replace(',', '.');
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
