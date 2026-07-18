import { describe, expect, it } from 'vitest';
import { parseDocs } from '../shared/src/serp/parse.js';

/** Собирает структуру ответа XMLStock из массива doc-ов одной группы. */
function docWith(docs: any[]) {
  return { yandexsearch: { response: { results: { grouping: { group: { doc: docs } } } } } };
}

describe('parseDocs', () => {
  it('органика: позиции, домен, снятие тегов', () => {
    const doc = docWith([
      { url: 'https://www.a.ru/1', title: '<hlword>Купить</hlword> дом', passages: { passage: 'текст' } },
      { url: 'https://b.ru/2', title: 'Заголовок' },
    ]);
    const { docs } = parseDocs(doc);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ position: 1, domain: 'a.ru', title: 'Купить дом' });
    expect(docs[0].text_bolds).toEqual(['Купить']);
    expect(docs[1].position).toBe(2);
  });

  it('SERP-фичи считаются в packs даже без url', () => {
    const doc = docWith([{ contenttype: 'video' }, { contenttype: 'images', url: 'not-a-url' }, { url: 'https://a.ru/1' }]);
    const { docs, packs } = parseDocs(doc);
    expect(packs.sort()).toEqual(['images', 'video']);
    expect(docs).toHaveLength(1); // только органика
  });

  it('битый организм-doc (url без http) отбрасывается, позиции не сдвигаются', () => {
    const doc = docWith([{ url: '' }, { url: 'https://a.ru/1' }, { url: 'ftp://x' }, { url: 'https://b.ru/2' }]);
    const { docs } = parseDocs(doc);
    expect(docs.map((d) => d.domain)).toEqual(['a.ru', 'b.ru']);
    expect(docs.map((d) => d.position)).toEqual([1, 2]);
  });

  it('ситилинки топ-1', () => {
    const doc = docWith([
      { url: 'https://a.ru/1', sitelinks: { sitelink: [{ title: 'Контакты' }, { title: 'О нас' }] } },
      { url: 'https://b.ru/2', sitelinks: { sitelink: [{ title: 'Другое' }] } },
    ]);
    const { sitelinksTop1 } = parseDocs(doc);
    expect(sitelinksTop1).toEqual(['Контакты', 'О нас']); // только у позиции 1
  });

  it('пустой ответ → пусто', () => {
    expect(parseDocs({})).toEqual({ docs: [], packs: [], sitelinksTop1: [] });
  });
});
