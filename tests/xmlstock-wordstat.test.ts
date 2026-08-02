import { describe, expect, it, vi } from 'vitest';
import {
  createRegionNamesCache,
  createWsRegionNames,
  flattenRegionsTree,
  parseHistory,
  parseRegions,
  parseWords,
  regionNameMap,
  validateWsDateOrder,
  wsDate,
} from '../servers/xmlstock/src/wordstat.js';

describe('parseWords', () => {
  it('парсит топ + ассоциации, count из строк в числа', () => {
    const r = parseWords({
      totalCount: '132584',
      results: [
        { phrase: 'пластиковые окна', count: '132584' },
        { phrase: 'купить окна', count: '15464' },
      ],
      associations: [{ phrase: 'стеклопакет', count: '36840' }],
    });
    expect(r.totalCount).toBe(132584);
    expect(r.results).toEqual([
      { phrase: 'пластиковые окна', count: 132584 },
      { phrase: 'купить окна', count: 15464 },
    ]);
    expect(r.associations[0]).toEqual({ phrase: 'стеклопакет', count: 36840 });
  });
  it('пустой/битый ответ → нули и []', () => {
    expect(parseWords({})).toEqual({ totalCount: 0, results: [], associations: [] });
    expect(parseWords(null).results).toEqual([]);
  });
  it('фразы без phrase отбрасываются', () => {
    expect(parseWords({ results: [{ count: '5' }, { phrase: 'ok', count: '3' }] }).results).toEqual([{ phrase: 'ok', count: 3 }]);
  });
});

describe('parseHistory', () => {
  it('date/count/share', () => {
    const r = parseHistory({ results: [{ date: '2026-01-01T00:00:00Z', count: '950163', share: 0.0097 }] });
    expect(r).toEqual([{ date: '2026-01-01T00:00:00Z', count: 950163, share: 0.0097 }]);
  });
  it('нет results → []', () => {
    expect(parseHistory({})).toEqual([]);
  });
});

describe('parseRegions', () => {
  const names = new Map([
    ['1', 'Москва и область'],
    ['2', 'Санкт-Петербург'],
  ]);
  it('подставляет имена из карты, парсит числа', () => {
    const r = parseRegions({ results: [{ region: '1', count: '265106', share: 0.0132, affinityIndex: 97.3 }] }, names);
    expect(r[0]).toEqual({ regionId: '1', name: 'Москва и область', count: 265106, share: 0.0132, affinityIndex: 97.3 });
  });
  it('неизвестный регион → name=null', () => {
    expect(parseRegions({ results: [{ region: '999', count: '1' }] }, names)[0].name).toBeNull();
  });
});

describe('flattenRegionsTree / regionNameMap', () => {
  const tree = {
    regions: [{ id: '225', label: 'Россия', children: [{ id: '3', label: 'Центр', children: [{ id: '213', label: 'Москва' }] }] }],
  };
  it('разворачивает дерево с путём', () => {
    const flat = flattenRegionsTree(tree);
    expect(flat).toContainEqual({ id: '213', name: 'Москва', path: 'Россия / Центр / Москва' });
    expect(flat).toContainEqual({ id: '225', name: 'Россия', path: 'Россия' });
    expect(flat).toHaveLength(3);
  });
  it('regionNameMap: id → имя', () => {
    const m = regionNameMap(tree);
    expect(m.get('213')).toBe('Москва');
    expect(m.get('225')).toBe('Россия');
  });
  it('пустое дерево → []', () => {
    expect(flattenRegionsTree({})).toEqual([]);
  });
});

describe('createRegionNamesCache', () => {
  const tree = { regions: [{ id: '225', label: 'Россия' }] };

  it('два параллельных вызова при холодном кэше → ОДИН fetch (дедуп in-flight)', async () => {
    const fetchTree = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5)); // имитация сети: второй вызов приходит, пока первый в полёте
      return tree;
    });
    const getNames = createRegionNamesCache(fetchTree);
    const [a, b] = await Promise.all([getNames(), getNames()]);
    expect(fetchTree).toHaveBeenCalledTimes(1);
    expect(a.get('225')).toBe('Россия');
    expect(b).toBe(a); // один и тот же результат
  });

  it('повторный вызов в пределах TTL — из кэша, без fetch', async () => {
    const fetchTree = vi.fn(async () => tree);
    const getNames = createRegionNamesCache(fetchTree);
    await getNames();
    const names = await getNames();
    expect(fetchTree).toHaveBeenCalledTimes(1);
    expect(names.get('225')).toBe('Россия');
  });

  it('ошибка fetch не кэшируется — следующий вызов ретраит', async () => {
    const fetchTree = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(tree);
    const getNames = createRegionNamesCache(fetchTree);
    await expect(getNames()).rejects.toThrow('boom');
    const names = await getNames();
    expect(names.get('225')).toBe('Россия');
    expect(fetchTree).toHaveBeenCalledTimes(2);
  });
});

describe('wsDate', () => {
  it('YYYY-MM-DD → DD.MM.YYYY', () => {
    expect(wsDate('2026-07-05')).toBe('05.07.2026');
  });
  it('month: start → 01, end → последний день месяца (включая февраль високосного)', () => {
    expect(wsDate('2026-07-15', { startOfMonth: true })).toBe('01.07.2026');
    expect(wsDate('2026-07-15', { endOfMonth: true })).toBe('31.07.2026');
    expect(wsDate('2024-02-10', { endOfMonth: true })).toBe('29.02.2024');
    expect(wsDate('2026-02-10', { endOfMonth: true })).toBe('28.02.2026');
  });
  it('не-ISO строка возвращается как есть', () => {
    expect(wsDate('05.07.2026')).toBe('05.07.2026');
  });
});

describe('validateWsDateOrder', () => {
  it('from > to → понятная ошибка; from <= to — ок', () => {
    expect(() => validateWsDateOrder('2026-08-01', '2026-07-01')).toThrow(/from \(2026-08-01\) позже to \(2026-07-01\)/);
    expect(() => validateWsDateOrder('2026-07-01', '2026-08-01')).not.toThrow();
    expect(() => validateWsDateOrder('2026-07-01', '2026-07-01')).not.toThrow();
  });
});

describe('createWsRegionNames', () => {
  const tree = { regions: [{ id: '225', label: 'Россия' }] };

  it('per-account кэши: разные аккаунты — разные fetch, повтор в пределах TTL — из кэша', async () => {
    const fetchTree = vi.fn(async (_account?: string) => tree);
    const getNames = createWsRegionNames(fetchTree);
    await getNames();
    await getNames(); // кэш основного аккаунта
    await getNames('client1');
    expect(fetchTree).toHaveBeenCalledTimes(2);
    expect(fetchTree.mock.calls[1][0]).toBe('client1');
  });
});
