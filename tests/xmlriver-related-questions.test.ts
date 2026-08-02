import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseXml } from '../shared/src/serp/xml.js';

// ENV_FILE вычисляется при импорте shared/config.js — env выставляется ДО динамического
// импорта модуля (образец — tests/xmlriver-suggest.test.ts). Временный env-файл делает тест
// герметичным: реальный ~/.config/seo-tools-mcp/.env не читается.
let related: typeof import('../servers/xmlriver/src/related.js');
let serp: typeof import('../servers/xmlriver/src/serp.js');
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-xmlriver-related-'));
  process.env.SEO_TOOLS_MCP_ENV = join(dir, '.env');
  writeFileSync(process.env.SEO_TOOLS_MCP_ENV, 'XMLRIVER_USER=u\nXMLRIVER_KEY=k\n', { mode: 0o600 });
  related = await import('../servers/xmlriver/src/related.js');
  serp = await import('../servers/xmlriver/src/serp.js');
});

afterAll(() => {
  delete process.env.SEO_TOOLS_MCP_ENV;
  rmSync(dir, { recursive: true, force: true });
});

function fakeRes(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

/** XML ответа setab=rq: n вопросов; withAnswers=false — пустые title/snippet/url (без опции кабинета). */
const rqXml = (withAnswers: boolean, n = 2) => {
  const items = Array.from({ length: n }, (_, i) => {
    const q = `Вопрос ${i + 1}?`;
    return withAnswers
      ? `<item><question>${q}</question><title>Источник ${i + 1}</title><snippet>Ответ ${i + 1}</snippet><url>https://example.com/a${i + 1}</url></item>`
      : `<item><question>${q}</question><title></title><snippet></snippet><url></url></item>`;
  }).join('');
  return `<yandexsearch><response><found priority="all">${n}</found><relatedQuestions>${items}</relatedQuestions></response></yandexsearch>`;
};

let trackSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // глушим stderr-логи (cost/retry); trackSpy на общем cost-логгере из serp.ts — проверка списаний
  vi.spyOn(console, 'error').mockImplementation(() => {});
  trackSpy = vi.spyOn(serp.cost, 'track');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** URL n-го вызова fetch. */
const fetchUrl = (fetch: ReturnType<typeof vi.fn>, call = 0) => new URL(String(fetch.mock.calls[call][0]));

describe('parseRelatedQuestions', () => {
  it('парсит items с ответами: question + title/snippet/url', () => {
    const doc = parseXml(rqXml(true, 2));
    const qs = related.parseRelatedQuestions(doc);
    expect(qs).toHaveLength(2);
    expect(qs[0]).toEqual({ question: 'Вопрос 1?', title: 'Источник 1', snippet: 'Ответ 1', url: 'https://example.com/a1' });
  });

  it('пустые title/snippet/url → undefined, вопросы остаются', () => {
    const doc = parseXml(rqXml(false, 2));
    const qs = related.parseRelatedQuestions(doc);
    expect(qs).toEqual([{ question: 'Вопрос 1?' }, { question: 'Вопрос 2?' }]);
  });

  it('единственный item (не массив) и item без question — обрабатываются', () => {
    const doc = parseXml(
      '<yandexsearch><response><relatedQuestions><item><question>Один?</question></item></relatedQuestions></response></yandexsearch>',
    );
    expect(related.parseRelatedQuestions(doc)).toEqual([{ question: 'Один?' }]);

    const empty = parseXml('<yandexsearch><response><relatedQuestions></relatedQuestions></response></yandexsearch>');
    expect(related.parseRelatedQuestions(empty)).toEqual([]);
  });
});

describe('collectRelatedQuestions', () => {
  it('успех с ответами: answers_available true, списание ×1', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes(rqXml(true, 3))));

    const r = await related.collectRelatedQuestions('купить квартиру', 10);
    expect(r.count).toBe(3);
    expect(r.answers_available).toBe(true);
    expect(r.note).toBeUndefined();
    expect(r.empty).toBeUndefined();
    expect(r.questions[1].url).toBe('https://example.com/a2');
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith('google');
  });

  it('пустые ответы (опция кабинета выключена) → answers_available false + note, вопросы есть', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes(rqXml(false, 3))));

    const r = await related.collectRelatedQuestions('купить квартиру', 10);
    expect(r.count).toBe(3);
    expect(r.questions[0]).toEqual({ question: 'Вопрос 1?' });
    expect(r.answers_available).toBe(false);
    expect(r.note).toMatch(/Related Questions с ответами/);
    expect(trackSpy).toHaveBeenCalledTimes(1);
  });

  it('GET setab=rq с обязательным count, query, user/key; region → lr, device шлётся', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes(rqXml(true, 1)));
    vi.stubGlobal('fetch', fetch);

    await related.collectRelatedQuestions('тест запрос', 25, 'Москва', 'mobile');
    const url = fetchUrl(fetch);
    expect(url.origin + url.pathname).toBe('https://xmlriver.com/search/xml');
    expect(url.searchParams.get('setab')).toBe('rq');
    expect(url.searchParams.get('count')).toBe('25');
    expect(url.searchParams.get('query')).toBe('тест запрос');
    expect(url.searchParams.get('lr')).toBe('213');
    expect(url.searchParams.get('device')).toBe('mobile');
    expect(url.searchParams.get('user')).toBe('u');
    expect(url.searchParams.get('key')).toBe('k');

    // без region lr не шлётся
    await related.collectRelatedQuestions('тест', 5);
    expect(fetchUrl(fetch, 1).searchParams.get('lr')).toBeNull();
  });

  it('код 15 (нет PAA-блока) → empty: true + note, запрос ТАРИФИЦИРОВАН', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeRes('<yandexsearch><response><error code="15">Ничего не найдено</error></response></yandexsearch>')),
    );

    const r = await related.collectRelatedQuestions('экзотика', 10);
    expect(r).toEqual({
      questions: [],
      count: 0,
      empty: true,
      answers_available: false,
      note: 'нет блока «Вопросы по теме» (код 15), запрос тарифицирован',
    });
    expect(trackSpy).toHaveBeenCalledTimes(1);
  });

  it('HTML-заглушка (неверные ключи) → ошибка БЕЗ списания', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes('<html><body>Authorization failed</body></html>')));
    await expect(related.collectRelatedQuestions('x', 10)).rejects.toThrow(/не-XML\/невалидный ответ/);
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('фатальный код 31 (авторизация) → ошибка БЕЗ списания', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeRes('<yandexsearch><response><error code="31">Ошибка авторизации</error></response></yandexsearch>')),
    );
    await expect(related.collectRelatedQuestions('x', 10)).rejects.toThrow(/XMLRiver error 31/);
    expect(trackSpy).not.toHaveBeenCalled();
  });
});
