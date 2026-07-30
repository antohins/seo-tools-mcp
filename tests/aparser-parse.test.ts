import { describe, expect, it } from 'vitest';
import {
  allResults,
  firstResult,
  normSerpItem,
  num,
  parseInfo,
  parseParserFields,
  parseProxies,
  parseSerpResult,
  parseSuggest,
} from '../servers/aparser/src/parse.js';

describe('num', () => {
  it('терпит пробелы-разделители и мусор', () => {
    expect(num('132 584')).toBe(132584);
    expect(num('42')).toBe(42);
    expect(num(null)).toBe(0);
    expect(num('abc')).toBe(0);
  });
});

describe('normSerpItem', () => {
  it('маппит алиасы link/anchor/snippet и позицию', () => {
    expect(normSerpItem({ link: 'https://a.ru', anchor: 'A', snippet: 'desc', pos: 3 }, 0)).toEqual({
      position: 3,
      url: 'https://a.ru',
      anchor: 'A',
      snippet: 'desc',
    });
  });
  it('позиция по индексу, если pos не задан; url/title-алиасы; flags пробрасываются', () => {
    expect(normSerpItem({ url: 'https://b.ru', title: 'B', description: 'd', flags: { featured: 1 } }, 4)).toEqual({
      position: 5,
      url: 'https://b.ru',
      anchor: 'B',
      snippet: 'd',
      flags: { featured: 1 },
    });
  });
});

describe('parseSerpResult', () => {
  it('реальная форма SE::Google: query-объект, related {key}, serp по индексу', () => {
    const r = parseSerpResult({
      query: { query: 'купить окна', orig: 'купить окна', first: 'купить окна' },
      success: 1,
      totalcount: '1 200 000',
      serp: [
        { link: 'https://x.ru', anchor: 'X', snippet: 's1', flags: { amp: 0 } },
        { link: 'https://y.ru', anchor: 'Y', snippet: 's2' },
      ],
      related: [{ key: 'окна пвх' }, { key: 'стеклопакеты' }],
      ads: [{ link: 'https://ad.ru', anchor: 'Ad', snippet: 'buy', position: 1 }],
    });
    expect(r.query).toBe('купить окна');
    expect(r.success).toBe(true);
    expect(r.totalcount).toBe(1200000);
    expect(r.count).toBe(2);
    expect(r.serp[0]).toEqual({ position: 1, url: 'https://x.ru', anchor: 'X', snippet: 's1', flags: { amp: 0 } });
    expect(r.serp[1].position).toBe(2);
    expect(r.related).toEqual(['окна пвх', 'стеклопакеты']);
    expect(r.ads[0].url).toBe('https://ad.ru');
    expect(r.diagnostic).toBeUndefined();
  });
  it('пустые «none» → null (totalcount/misspell)', () => {
    const r = parseSerpResult({ query: { query: 'q' }, success: 1, totalcount: 'none', misspell: 'none', serp: [] });
    expect(r.totalcount).toBeNull();
    expect(r.misspell).toBeNull();
  });
  it('провал (success:0 + reCaptcha) → diagnostic про капчу', () => {
    const r = parseSerpResult({
      query: { query: 'coffee' },
      success: 0,
      totalcount: 'none',
      serp: [],
      info: { success: 0, retries: 22, stats: { reCaptchaShows: 8, retries: 22 } },
    });
    expect(r.success).toBe(false);
    expect(r.diagnostic).toMatch(/reCaptcha/i);
  });
  it('пустой/битый результат → безопасные значения без diagnostic', () => {
    expect(parseSerpResult(null)).toEqual({
      query: '',
      success: true,
      totalcount: null,
      misspell: null,
      count: 0,
      serp: [],
      related: [],
      ads: [],
    });
  });
});

describe('firstResult / allResults', () => {
  it('firstResult берёт results[0], allResults — весь массив', () => {
    const data = { results: [{ query: 'a' }, { query: 'b' }] };
    expect(firstResult(data)).toEqual({ query: 'a' });
    expect(allResults(data)).toHaveLength(2);
  });
  it('нет results → null и []', () => {
    expect(firstResult({})).toBeNull();
    expect(allResults(null)).toEqual([]);
  });
});

describe('parseSuggest', () => {
  it('реальная форма SE::*::Suggest: плоский results [suggest,type,…]', () => {
    // как на живом инстансе: ['кофемашина', 1, 'кофе', 1, …]
    expect(parseSuggest({ results: ['кофемашина', 1, 'кофе', 1, 'кофе купить', 1] })).toEqual(['кофемашина', 'кофе', 'кофе купить']);
  });
  it('маркер типа строкой («1», Perl-сериализация) тоже отсеивается', () => {
    expect(parseSuggest({ results: ['кофе', '1', 'чай', '1'] })).toEqual(['кофе', 'чай']);
  });
  it('объектная форма с type-сиблингом: type игнорируется', () => {
    expect(
      parseSuggest({
        results: [
          { suggest: 'iphone 15', type: 0 },
          { suggest: 'iphone 15 pro', type: 0 },
        ],
      }),
    ).toEqual(['iphone 15', 'iphone 15 pro']);
  });
  it('терпит альтернативные формы (suggest[]/serp[]); link подсказкой не считается', () => {
    expect(parseSuggest({ suggest: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(parseSuggest({ serp: [{ anchor: 'купить' }] })).toEqual(['купить']);
    expect(parseSuggest({ serp: [{ link: 'http://x.com' }] })).toEqual([]);
  });
  it('пусто → []', () => {
    expect(parseSuggest({})).toEqual([]);
    expect(parseSuggest(null)).toEqual([]);
  });
});

describe('parseInfo', () => {
  it('версия, парсеры, очередь/потоки', () => {
    const r = parseInfo({
      version: '1.2.1234',
      availableParsers: ['SE::Google', 'SE::Yandex', 'Net::HTTP'],
      tasksInQueue: '2',
      workingTasks: 1,
      activeThreads: '30',
      activeProxyCheckerThreads: 15,
      pid: 4242,
    });
    expect(r.version).toBe('1.2.1234');
    expect(r.parsersCount).toBe(3);
    expect(r.parsers).toContain('SE::Yandex');
    expect(r.tasksInQueue).toBe(2);
    expect(r.activeThreads).toBe(30);
    expect(r.pid).toBe('4242');
  });
  it('пустой ответ → нули и []', () => {
    const r = parseInfo({});
    expect(r.parsersCount).toBe(0);
    expect(r.version).toBeNull();
  });
});

describe('parseProxies', () => {
  it('счётчик + разбивка по типам, креды НЕ выводятся', () => {
    const r = parseProxies({
      '1.2.3.4:8080': ['http', 'login', 'pass'],
      '5.6.7.8:1080': ['socks'],
      '9.9.9.9:3128': ['http'],
    });
    expect(r.count).toBe(3);
    expect(r.byType).toEqual({ http: 2, socks: 1 });
    expect(r.proxies[0]).toEqual({ address: '1.2.3.4:8080', type: 'http' });
    // ни логина, ни пароля в выводе
    expect(JSON.stringify(r)).not.toContain('login');
    expect(JSON.stringify(r)).not.toContain('pass');
  });
  it('пустой ответ → count 0', () => {
    expect(parseProxies({}).count).toBe(0);
    expect(parseProxies(null).count).toBe(0);
  });
});

describe('parseParserFields', () => {
  it('flat-поля и имена array-полей', () => {
    const r = parseParserFields({ results: { arrays: { serp: {}, ads: {}, related: {} }, flat: ['query', 'totalcount'] } });
    expect(r.flat).toEqual(['query', 'totalcount']);
    expect(r.arrays).toEqual(['serp', 'ads', 'related']);
  });
  it('пусто → []', () => {
    expect(parseParserFields({})).toEqual({ flat: [], arrays: [] });
  });
});
