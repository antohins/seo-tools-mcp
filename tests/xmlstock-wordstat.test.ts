import { describe, expect, it } from 'vitest';
import { flattenRegionsTree, parseHistory, parseRegions, parseWords, regionNameMap } from '../servers/xmlstock/src/wordstat.js';

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
