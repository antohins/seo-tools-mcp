import { describe, expect, it } from 'vitest';
import { parseImages, parseNews, parseVideo } from '../servers/xmlstock/src/verticals.js';

/** Обёртка: массив doc-ов одной группы в структуру ответа XMLStock. */
function docWith(docs: any[]) {
  return { yandexsearch: { response: { results: { grouping: { group: { doc: docs } } } } } };
}

describe('parseImages', () => {
  it('извлекает url страницы, imageUrl и title, нумерует', () => {
    const doc = docWith([
      { url: 'https://a.ru/p', imgurl: 'https://a.ru/i.jpg', title: 'Картинка' },
      { url: 'https://b.ru/p', imgurl: 'https://b.ru/i.jpg', title: 'Вторая' },
    ]);
    const r = parseImages(doc);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ position: 1, url: 'https://a.ru/p', imageUrl: 'https://a.ru/i.jpg', title: 'Картинка' });
    expect(r[1].position).toBe(2);
  });
  it('пустой ответ → []', () => {
    expect(parseImages({})).toEqual([]);
  });
});

describe('parseNews', () => {
  it('извлекает источник, дату, сниппет', () => {
    const doc = docWith([
      { url: 'https://n.ru/1', title: 'Заголовок', media: 'Издание', pubDate: '2 дня назад', passages: { passage: 'текст' } },
    ]);
    const r = parseNews(doc);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      position: 1,
      url: 'https://n.ru/1',
      title: 'Заголовок',
      source: 'Издание',
      date: '2 дня назад',
      snippet: 'текст',
    });
  });
});

describe('parseVideo', () => {
  it('url как объект: достаёт host/channel/duration', () => {
    const doc = docWith([
      {
        url: { '#text': 'https://youtube.com/watch?v=x', '@_host': 'YouTube', '@_chanel': 'Канал', '@_duration': '3:20' },
        imgurl: 'https://thumb.jpg',
        title: 'Видео',
        passages: { passage: 'описание' },
      },
    ]);
    const r = parseVideo(doc);
    expect(r[0]).toEqual({
      position: 1,
      url: 'https://youtube.com/watch?v=x',
      title: 'Видео',
      thumbnail: 'https://thumb.jpg',
      host: 'YouTube',
      channel: 'Канал',
      duration: '3:20',
      snippet: 'описание',
    });
  });
  it('url как строка — тоже ок, host/channel пустые', () => {
    const r = parseVideo(docWith([{ url: 'https://v.ru/x', title: 'V' }]));
    expect(r[0]).toMatchObject({ url: 'https://v.ru/x', host: '', channel: '', duration: '' });
  });
});
