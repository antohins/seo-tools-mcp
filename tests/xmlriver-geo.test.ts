import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// CONFIG_DIR/ENV_FILE вычисляются при импорте shared/config.js — env выставляется ДО
// динамического импорта (образец — tests/xmlriver-suggest.test.ts). Кэш geo.csv
// пишется в <CONFIG_DIR>/cache/ — то есть во временный каталог, тест герметичен.
let geo: typeof import('../servers/xmlriver/src/geo.js');
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-xmlriver-geo-'));
  process.env.SEO_TOOLS_MCP_ENV = join(dir, '.env');
  writeFileSync(process.env.SEO_TOOLS_MCP_ENV, '', { mode: 0o600 });
  geo = await import('../servers/xmlriver/src/geo.js');
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

// Фикстура geo.csv: заголовок как у реального справочника; «Moscow» неоднозначен
// (RU + US), «Oldtown» — не-Active (должен отфильтроваться).
const GEO_CSV = [
  'Criteria ID,Name,Canonical Name,Parent ID,Country Code,Target Type,Status',
  '1011969,Moscow,"Moscow,Russia",2643,RU,City,Active',
  '1012040,Saint Petersburg,"Saint Petersburg,Saint Petersburg,Russia",20968,RU,City,Active',
  '20867,Moscow,"Moscow,Idaho,United States",20076,US,City,Active',
  '999999,Oldtown,"Oldtown,Russia",2643,RU,City,Removed',
  '',
].join('\n');

describe('resolveCountry', () => {
  it('число → как есть; ISO (регистр не важен) → id из справочника', () => {
    expect(geo.resolveCountry('2643')).toBe(2643);
    expect(geo.resolveCountry('RU')).toBe(2643);
    expect(geo.resolveCountry('ru')).toBe(2643);
    expect(geo.resolveCountry('us')).toBe(2840);
  });

  it('пустой вход → undefined', () => {
    expect(geo.resolveCountry(undefined)).toBeUndefined();
    expect(geo.resolveCountry('')).toBeUndefined();
  });

  it('неизвестный код → понятная ошибка со ссылкой на справочник', () => {
    expect(() => geo.resolveCountry('XX')).toThrow(/country «XX» не распознан/);
    expect(() => geo.resolveCountry('XX')).toThrow(/countries\.xlsx/);
    expect(() => geo.resolveCountry('Russia')).toThrow(/не распознан/);
  });
});

describe('resolveDomainId', () => {
  it('известные домены → числовые id', () => {
    expect(geo.resolveDomainId('ru')).toBe(143);
    expect(geo.resolveDomainId('com')).toBe(37);
    expect(geo.resolveDomainId('RU')).toBe(143); // регистр не важен
  });

  it('неизвестный домен → строка как есть (обратная совместимость)', () => {
    expect(geo.resolveDomainId('yy')).toBe('yy');
  });
});

describe('parseGeoCsv', () => {
  it('индекс по lower-case имени, только Active, кавычки с запятыми разбираются', () => {
    const idx = geo.parseGeoCsv(GEO_CSV);
    expect(idx.get('moscow')).toEqual([
      { id: 1011969, countryCode: 'RU' },
      { id: 20867, countryCode: 'US' },
    ]);
    expect(idx.get('saint petersburg')).toEqual([{ id: 1012040, countryCode: 'RU' }]);
    expect(idx.has('oldtown')).toBe(false); // Status=Removed отфильтрован
  });
});

describe('resolveLocation', () => {
  it('числовой criteria id → напрямую, БЕЗ сети', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('сеть запрещена в тесте'));
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(geo.resolveLocation('1011969')).resolves.toEqual({ loc: 1011969 });
      await expect(geo.resolveLocation('1011969', 'RU')).resolves.toEqual({ loc: 1011969, country: 2643 });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('невалидный country падает понятной ошибкой до обращения в сеть', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(geo.resolveLocation('Moscow', 'XX')).rejects.toThrow(/не распознан/);
      await expect(geo.resolveLocation('1011969', 'XX')).rejects.toThrow(/не распознан/);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // geo.csv скачивается один раз на весь файл тестов (in-memory кэш модуля):
  // суммарно ОДИН fetch на все resolveLocation по имени ниже.
  const fetch = vi.fn();
  const fetchCalls = () => fetch.mock.calls.length;

  it('имя города (case-insensitive) → loc + автовывод country из geo.csv', async () => {
    fetch.mockResolvedValue(fakeRes(GEO_CSV));
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(geo.resolveLocation('saint petersburg')).resolves.toEqual({ loc: 1012040, country: 2643 });
      expect(fetchCalls()).toBe(1);
      // повторный вызов — из in-memory кэша, сеть не дёргается
      await expect(geo.resolveLocation('Saint Petersburg')).resolves.toEqual({ loc: 1012040, country: 2643 });
      expect(fetchCalls()).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('неоднозначное имя без country → первое совпадение + note', async () => {
    const r = await geo.resolveLocation('Moscow');
    expect(r.loc).toBe(1011969);
    expect(r.country).toBe(2643);
    expect(r.note).toMatch(/несколько локаций с именем «Moscow»/);
  });

  it('неоднозначное имя + country → выбор по стране, без note', async () => {
    await expect(geo.resolveLocation('Moscow', 'US')).resolves.toEqual({ loc: 20867, country: 2840 });
    // country числом — дизамбигуация через обратный маппинг id → ISO
    await expect(geo.resolveLocation('Moscow', '2840')).resolves.toEqual({ loc: 20867, country: 2840 });
  });

  it('явный country перекрывает автовывод из города', async () => {
    await expect(geo.resolveLocation('Saint Petersburg', 'US')).resolves.toEqual({ loc: 1012040, country: 2840 });
  });

  it('неизвестный город → понятная ошибка со ссылкой на geo.csv', async () => {
    await expect(geo.resolveLocation('Нью-Васюки')).rejects.toThrow(/не найден в справочнике geo\.csv/);
    await expect(geo.resolveLocation('Нью-Васюки')).rejects.toThrow(/geo\.csv/);
    expect(fetchCalls()).toBe(1); // за весь файл — один fetch
  });
});

describe('createGeoIndexLoader', () => {
  const cacheFile = () => join(dir, `geo-loader-${Math.random().toString(36).slice(2)}.csv`);

  it('in-memory кэш: повторный вызов без повторного fetch', async () => {
    const fetchCsv = vi.fn().mockResolvedValue(GEO_CSV);
    const load = geo.createGeoIndexLoader({ cacheFile: cacheFile(), fetchCsv });
    await load();
    await load();
    expect(fetchCsv).toHaveBeenCalledTimes(1);
  });

  it('дисковый кэш: новый инстанс читает файл без сети', async () => {
    const file = cacheFile();
    const fetchCsv = vi.fn().mockResolvedValue(GEO_CSV);
    await geo.createGeoIndexLoader({ cacheFile: file, fetchCsv })();
    expect(fetchCsv).toHaveBeenCalledTimes(1);

    const load2 = geo.createGeoIndexLoader({ cacheFile: file, fetchCsv });
    const idx = await load2();
    expect(fetchCsv).toHaveBeenCalledTimes(1); // свежий файл — сеть не нужна
    expect(idx.get('saint petersburg')?.[0].id).toBe(1012040);
  });

  it('TTL: протухший кэш перечитывается из сети', async () => {
    vi.useFakeTimers();
    try {
      const file = cacheFile();
      const fetchCsv = vi.fn().mockResolvedValue(GEO_CSV);
      const load = geo.createGeoIndexLoader({ cacheFile: file, ttlMs: 1000, fetchCsv });
      await load();
      await load(); // in-memory, TTL не вышел
      expect(fetchCsv).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2000); // Date.now сдвинут за TTL (mem и mtime)
      await load();
      expect(fetchCsv).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('in-flight дедуп: параллельные вызовы делят один fetch', async () => {
    let resolveCsv!: (v: string) => void;
    const fetchCsv = vi.fn().mockImplementation(() => new Promise<string>((r) => (resolveCsv = r)));
    const load = geo.createGeoIndexLoader({ cacheFile: cacheFile(), fetchCsv });
    const p1 = load();
    const p2 = load();
    resolveCsv(GEO_CSV);
    const [i1, i2] = await Promise.all([p1, p2]);
    expect(fetchCsv).toHaveBeenCalledTimes(1);
    expect(i2.get('moscow')).toEqual(i1.get('moscow'));
  });
});

describe('resolveGeo', () => {
  it('оба входа пустые → undefined (поле geo в ответе не эхим)', async () => {
    await expect(geo.resolveGeo()).resolves.toBeUndefined();
    await expect(geo.resolveGeo(undefined, undefined)).resolves.toBeUndefined();
  });

  it('только country → { country } БЕЗ сети', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('сеть запрещена в тесте'));
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(geo.resolveGeo(undefined, 'RU')).resolves.toEqual({ country: 2643 });
      await expect(geo.resolveGeo(undefined, '2643')).resolves.toEqual({ country: 2643 });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('числовой location → { loc } БЕЗ сети; с country — оба', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('сеть запрещена в тесте'));
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(geo.resolveGeo('1011969')).resolves.toEqual({ loc: 1011969 });
      await expect(geo.resolveGeo('1011969', 'US')).resolves.toEqual({ loc: 1011969, country: 2840 });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('имя города → loc + автовывод country (in-memory кэш geo.csv уже прогрет выше)', async () => {
    await expect(geo.resolveGeo('Saint Petersburg')).resolves.toEqual({ loc: 1012040, country: 2643 });
  });
});

describe('buildSerpParams (гео-интеграция)', () => {
  const base = {
    query: 'x',
    device: 'desktop' as const,
    region: 'Москва',
    exactQuery: false,
    safeSearch: 'moderate' as const,
    includeAds: false,
  };
  let serp: typeof import('../servers/xmlriver/src/serp.js');

  beforeAll(async () => {
    serp = await import('../servers/xmlriver/src/serp.js');
  });

  it('google: loc/country уходят в params, searchDomain маппится в числовой id', () => {
    const p = serp.buildSerpParams({ ...base, engine: 'google', loc: 1011969, country: 2643, searchDomain: 'com' });
    expect(p.loc).toBe(1011969);
    expect(p.country).toBe(2643);
    expect(p.domain).toBe(37);
  });

  it('google: дефолтный домен ru → 143; неизвестный домен — строкой', () => {
    expect(serp.buildSerpParams({ ...base, engine: 'google' }).domain).toBe(143);
    expect(serp.buildSerpParams({ ...base, engine: 'google', searchDomain: 'yy' }).domain).toBe('yy');
  });

  it('yandex: loc/country НЕ шлём, домен остаётся строкой', () => {
    const p = serp.buildSerpParams({ ...base, engine: 'yandex', loc: 1011969, country: 2643 });
    expect(p.loc).toBeUndefined();
    expect(p.country).toBeUndefined();
    expect(p.domain).toBe('ru');
    expect(p.lr).toBe(213); // гео Яндекса — по-прежнему lr
  });

  it('buildVerticalParams: домен маппится в числовой id', () => {
    expect(serp.buildVerticalParams({ query: 'x', device: 'desktop' }).domain).toBe(143);
    expect(serp.buildVerticalParams({ query: 'x', device: 'desktop', searchDomain: 'de' }).domain).toBe(geo.resolveDomainId('de'));
  });
});
