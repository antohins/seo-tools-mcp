import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseXml } from '../shared/src/serp/xml.js';

// ENV_FILE вычисляется при импорте shared/config.js — env выставляется ДО динамического
// импорта модуля (образец — tests/xmlriver-related-questions.test.ts). Временный env-файл
// делает тест герметичным: реальный ~/.config/seo-tools-mcp/.env не читается.
let maps: typeof import('../servers/xmlriver/src/maps.js');
let serp: typeof import('../servers/xmlriver/src/serp.js');
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-xmlriver-maps-'));
  process.env.SEO_TOOLS_MCP_ENV = join(dir, '.env');
  writeFileSync(process.env.SEO_TOOLS_MCP_ENV, 'XMLRIVER_USER=u\nXMLRIVER_KEY=k\n', { mode: 0o600 });
  maps = await import('../servers/xmlriver/src/maps.js');
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

// Фикстура из доки XMLRiver (https://xmlriver.com/apidoc/api-maps/): 2 item, все поля;
// у первого url/phone/review/price пустые → должны стать undefined.
const MAPS_XML = `<yandexsearch version="1.0"><response date="20240626T135440">
  <found priority="all">10</found>
  <maps>
    <item>
      <title>PERK Cafe</title>
      <stars>4,7</stars>
      <type>Кафе</type>
      <address>· ул. Вольская, 63/69</address>
      <url></url>
      <phone></phone>
      <review></review>
      <possibility>Еда в заведении ⋅ Заказ с улицы ⋅ Доставка</possibility>
      <latitude>51.5299502</latitude>
      <longitude>46.022773</longitude>
      <placeid>ChIJNY-Nx77HFEERe9R4sgvI1Fw</placeid>
      <countreviews>1400</countreviews>
      <accessibility>false</accessibility>
      <price></price>
      <gasprice></gasprice>
    </item>
    <item>
      <title>Кафе "По Щучьему Велению"</title>
      <stars>4,7</stars>
      <type>Кафе</type>
      <address>· ул. Советская, 45</address>
      <url>https://shuka.example.ru/</url>
      <phone>+7 (8452) 00-00-00</phone>
      <review>Отличное место</review>
      <possibility>Еда в заведении ⋅ Еда навынос</possibility>
      <latitude>51.5292109</latitude>
      <longitude>46.020041</longitude>
      <placeid>ChIJHx6uAbzHFEER9WtY98DaixQ</placeid>
      <countreviews>150</countreviews>
      <accessibility>true</accessibility>
      <price>₽₽</price>
      <gasprice></gasprice>
    </item>
  </maps>
</response></yandexsearch>`;

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

describe('parseMaps (xmlriver)', () => {
  it('фикстура из доки: 2 item со всеми полями, десятичная запятая в stars', () => {
    const places = maps.parseMaps(parseXml(MAPS_XML));
    expect(places).toHaveLength(2);
    expect(places[0]).toEqual({
      title: 'PERK Cafe',
      stars: 4.7,
      type: 'Кафе',
      address: '· ул. Вольская, 63/69',
      features: ['Еда в заведении', 'Заказ с улицы', 'Доставка'],
      lat: 51.5299502,
      lng: 46.022773,
      place_id: 'ChIJNY-Nx77HFEERe9R4sgvI1Fw',
      reviews_count: 1400,
      accessibility: false,
    });
    expect(places[1]).toEqual({
      title: 'Кафе "По Щучьему Велению"',
      stars: 4.7,
      type: 'Кафе',
      address: '· ул. Советская, 45',
      url: 'https://shuka.example.ru/',
      phone: '+7 (8452) 00-00-00',
      review: 'Отличное место',
      features: ['Еда в заведении', 'Еда навынос'],
      lat: 51.5292109,
      lng: 46.020041,
      place_id: 'ChIJHx6uAbzHFEER9WtY98DaixQ',
      reviews_count: 150,
      accessibility: true,
      price: '₽₽',
    });
  });

  it('одиночный item (не массив) → массив из одного места', () => {
    const doc = parseXml(
      '<yandexsearch><response><maps><item><title>Одно</title><latitude>55.75</latitude><longitude>37.61</longitude></item></maps></response></yandexsearch>',
    );
    expect(maps.parseMaps(doc)).toEqual([{ title: 'Одно', lat: 55.75, lng: 37.61 }]);
  });

  it('item без title и координат отбрасывается; пустой maps → []', () => {
    const doc = parseXml('<yandexsearch><response><maps><item><type>Кафе</type></item></maps></response></yandexsearch>');
    expect(maps.parseMaps(doc)).toEqual([]);
    expect(maps.parseMaps({})).toEqual([]);
  });
});

describe('mapsCoordsSchema', () => {
  it('принимает «lat,lng» со знаком и дробной частью', () => {
    expect(maps.mapsCoordsSchema.safeParse('51.5468,45.9968').success).toBe(true);
    expect(maps.mapsCoordsSchema.safeParse('-33.86,151.2').success).toBe(true);
    expect(maps.mapsCoordsSchema.safeParse('55,37').success).toBe(true);
  });

  it('отклоняет мусор', () => {
    for (const bad of ['', '55.75', '55.75;37.61', '55.75,', 'a,b', '55.75,37.61,1', ' 55.75,37.61 ']) {
      expect(maps.mapsCoordsSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('collectMaps', () => {
  it('успех: places + found из <found priority="all">, списание ×1', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes(MAPS_XML)));

    const r = await maps.collectMaps('кафе', '51.5468,45.9968', 12, 20);
    expect(r.count).toBe(2);
    expect(r.places[0].title).toBe('PERK Cafe');
    expect(r.found).toBe(10);
    expect(r.empty).toBeUndefined();
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith('google');
  });

  it('URL: setab=maps, zoom, coords, count, query, user/key; region → lr', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes(MAPS_XML));
    vi.stubGlobal('fetch', fetch);

    await maps.collectMaps('стоматология', '55.75,37.61', 14, 30, 'Москва');
    const url = fetchUrl(fetch);
    expect(url.origin + url.pathname).toBe('https://xmlriver.com/search/xml');
    expect(url.searchParams.get('setab')).toBe('maps');
    expect(url.searchParams.get('zoom')).toBe('14');
    expect(url.searchParams.get('coords')).toBe('55.75,37.61');
    expect(url.searchParams.get('count')).toBe('30');
    expect(url.searchParams.get('query')).toBe('стоматология');
    expect(url.searchParams.get('lr')).toBe('213');
    expect(url.searchParams.get('user')).toBe('u');
    expect(url.searchParams.get('key')).toBe('k');

    // без region lr не шлётся
    await maps.collectMaps('кафе', '55.75,37.61', 12, 20);
    expect(fetchUrl(fetch, 1).searchParams.get('lr')).toBeNull();
  });

  it('код 15 → empty: true + note, запрос ТАРИФИЦИРОВАН', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeRes('<yandexsearch><response><error code="15">Ничего не найдено</error></response></yandexsearch>')),
    );

    const r = await maps.collectMaps('экзотика', '55.75,37.61', 12, 20);
    expect(r).toEqual({ places: [], count: 0, found: null, empty: true, note: 'пустая выдача (код 15), запрос тарифицирован' });
    expect(trackSpy).toHaveBeenCalledTimes(1);
  });

  it('HTML-заглушка (неверные ключи) → ошибка БЕЗ списания', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes('<html><body>Authorization failed</body></html>')));
    await expect(maps.collectMaps('x', '55.75,37.61', 12, 20)).rejects.toThrow(/не-XML\/невалидный ответ/);
    expect(trackSpy).not.toHaveBeenCalled();
  });
});
