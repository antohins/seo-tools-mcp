import { describe, expect, it } from 'vitest';
import { flattenRegions } from '../servers/wordstat/src/regions.js';

describe('flattenRegions', () => {
  it('рекурсивно собирает id→название из дерева', () => {
    const tree = [
      {
        id: '225',
        label: 'Россия',
        children: [
          { id: '1', label: 'Москва и область', children: [{ id: '213', label: 'Москва' }] },
          { id: '2', label: 'Санкт-Петербург' },
        ],
      },
    ];
    const m = flattenRegions(tree);
    expect(m.get('225')).toBe('Россия');
    expect(m.get('213')).toBe('Москва');
    expect(m.get('2')).toBe('Санкт-Петербург');
    expect(m.size).toBe(4);
  });
  it('пустое/undefined → пустая карта', () => {
    expect(flattenRegions(undefined).size).toBe(0);
    expect(flattenRegions([]).size).toBe(0);
  });
  it('узлы без id/label пропускаются', () => {
    expect(flattenRegions([{ children: [{ id: '1', label: 'A' }] } as any]).get('1')).toBe('A');
  });
});
