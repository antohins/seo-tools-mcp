import { describe, it, expect } from 'vitest';
import { parseXml, asArray, extractBolds, stripTags, domainOf } from '../servers/xmlstock/src/xml.js';

describe('domainOf', () => {
  it('вырезает www', () => {
    expect(domainOf('https://www.example.com/path?q=1')).toBe('example.com');
  });
  it('поддомен сохраняется', () => {
    expect(domainOf('https://sub.example.com/')).toBe('sub.example.com');
  });
  it('битый url → пустая строка', () => {
    expect(domainOf('not-a-url')).toBe('');
    expect(domainOf('')).toBe('');
  });
});

describe('asArray', () => {
  it('undefined/null → []', () => {
    expect(asArray(undefined)).toEqual([]);
    expect(asArray(null)).toEqual([]);
  });
  it('единичный объект → массив из одного', () => {
    expect(asArray('x')).toEqual(['x']);
  });
  it('массив пропускается', () => {
    expect(asArray(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('stripTags', () => {
  it('убирает hlword и прочие теги', () => {
    expect(stripTags('<hlword>купить</hlword> квартиру')).toBe('купить квартиру');
  });
  it('декодирует сущности', () => {
    expect(stripTags('M&amp;M &lt;b&gt; &#39;x&#39;')).toBe("M&M <b> 'x'");
  });
  it('схлопывает пробелы и тримит', () => {
    expect(stripTags('  a   b  ')).toBe('a b');
  });
  it('undefined/null → пустая строка', () => {
    expect(stripTags(undefined)).toBe('');
    expect(stripTags(null as unknown as string)).toBe('');
  });
});

describe('extractBolds', () => {
  it('соседние hlword склеиваются в одну фразу', () => {
    expect(extractBolds('<hlword>купить</hlword> <hlword>квартиру</hlword>')).toEqual(['купить квартиру']);
  });
  it('разделённые текстом hlword — отдельные', () => {
    expect(extractBolds('<hlword>a</hlword> foo <hlword>b</hlword>')).toEqual(['a', 'b']);
  });
  it('нет подсветок → []', () => {
    expect(extractBolds('обычный текст')).toEqual([]);
    expect(extractBolds(undefined)).toEqual([]);
  });
});

describe('parseXml', () => {
  it('значения — строки (parseTagValue:false)', () => {
    const doc = parseXml('<r><a>1</a></r>');
    expect(doc.r.a).toBe('1');
  });
  it('атрибуты с префиксом @_', () => {
    const doc = parseXml('<r><e code="15">x</e></r>');
    expect(doc.r.e['@_code']).toBe('15');
  });
});
