import { describe, expect, it } from 'vitest';
import { decodeEntities, stripTags } from '../shared/src/serp/xml.js';

describe('decodeEntities', () => {
  it('числовые entities: десятичные и hex', () => {
    expect(decodeEntities('&#171;текст&#187;')).toBe('«текст»');
    expect(decodeEntities('&#x2026;')).toBe('…');
    expect(decodeEntities('&#039;')).toBe("'");
    expect(decodeEntities('&#39;')).toBe("'");
  });
  it('именованные: apos, nbsp, mdash, laquo/raquo', () => {
    expect(decodeEntities('&laquo;а&raquo; &mdash; б&apos;')).toBe("«а» — б'");
    expect(decodeEntities('&apos;')).toBe("'");
    expect(decodeEntities('a&nbsp;b')).toBe('a\u00A0b');
  });
  it('&amp; не «съедает» последующий entity: &amp;lt; → &lt;, а не «<»', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeEntities('M&amp;M')).toBe('M&M');
  });
  it('неизвестные и мусорные entities не трогаем', () => {
    expect(decodeEntities('&unknown;')).toBe('&unknown;');
    expect(decodeEntities('&#99999999;')).toBe('&#99999999;');
  });
});

describe('stripTags: entities в сниппете', () => {
  it('сниппет с &#171; и &nbsp;', () => {
    expect(stripTags('<hlword>&#171;Айфон&#187;</hlword> 16&nbsp;ГБ &mdash; купить')).toBe('«Айфон» 16 ГБ — купить');
  });
});
