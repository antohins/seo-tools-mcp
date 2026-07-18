import { describe, expect, it } from 'vitest';
import { parseImages, parseNews } from '../servers/xmlriver/src/verticals.js';

/** Обёртка: массив doc-ов одной группы в структуру ответа XMLRiver (Yandex.XML). */
function docWith(docs: any[]) {
  return { yandexsearch: { response: { results: { grouping: { group: { doc: docs } } } } } };
}

describe('parseImages (xmlriver)', () => {
  it('извлекает url, imageUrl, title, source и размеры', () => {
    const doc = docWith([
      {
        url: 'https://a.ru/p',
        imgurl: 'https://a.ru/i.jpg',
        title: 'Картинка',
        displaylink: 'A.RU',
        originalwidth: '960',
        originalheight: '1282',
      },
    ]);
    const r = parseImages(doc);
    expect(r[0]).toEqual({
      position: 1,
      url: 'https://a.ru/p',
      imageUrl: 'https://a.ru/i.jpg',
      title: 'Картинка',
      source: 'A.RU',
      width: 960,
      height: 1282,
    });
  });
  it('размеры/источник опциональны: 0 или пусто → поля отсутствуют', () => {
    const r = parseImages(docWith([{ url: 'https://b.ru/p', imgurl: 'https://b.ru/i.jpg', title: 'X', originalwidth: '0' }]));
    expect(r[0]).toEqual({ position: 1, url: 'https://b.ru/p', imageUrl: 'https://b.ru/i.jpg', title: 'X' });
  });
  it('пустой ответ → []', () => {
    expect(parseImages({})).toEqual([]);
  });
});

describe('parseNews (xmlriver)', () => {
  it('извлекает источник (media), дату (pubDate), сниппет', () => {
    const doc = docWith([
      { url: 'https://n.ru/1', title: 'Заголовок', media: 'Издание', pubDate: '9 часов назад', passages: { passage: 'текст' } },
    ]);
    expect(parseNews(doc)[0]).toMatchObject({
      position: 1,
      url: 'https://n.ru/1',
      title: 'Заголовок',
      source: 'Издание',
      date: '9 часов назад',
      snippet: 'текст',
    });
  });
  it('doc без url отбрасывается', () => {
    expect(parseNews(docWith([{ title: 'нет url' }]))).toEqual([]);
  });
});
