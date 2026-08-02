/**
 * Сбор блока «Вопросы по теме» (People Also Ask) Google через XMLRiver (setab=rq) —
 * вынесен из index.ts ради юнит-тестов.
 * Лайв-подтверждено (2026-08, user=7691):
 *  - GET https://xmlriver.com/search/xml?setab=rq&count=N&query=... — параметр count
 *    ОБЯЗАТЕЛЕН (без него ошибка 15), максимум 50 (больше приводится к 50 автоматически);
 *  - ответ — Yandex.XML: response/relatedQuestions/item[] { question, title, snippet, url };
 *  - ВАЖНО: title/snippet/url приходят ПУСТЫМИ, если в кабинете XMLRiver не включена
 *    платная опция «Related Questions с ответами» (настройки сбора). Вопросы (question)
 *    парсятся всегда — ответы только при включённой опции;
 *  - запрос без PAA-блока → ошибка 15 (та же семантика «пустой выдачи», что в SERP:
 *    запрос тарифицирован) — обрабатывается как empty: true по образцу collectSerp;
 *  - HTTP-ретраи/коды/учёт расхода — общие, в xmlriverGet из ./serp.js.
 */
import { asArray, stripTags } from '@seo-tools/shared/serp';
import { GOOGLE_URL, isEmptySerp, resolveLr, xmlriverGet } from './serp.js';

export interface RelatedQuestion {
  /** текст вопроса (приходит всегда) */
  question: string;
  /** заголовок источника ответа — только при платной опции кабинета «Related Questions с ответами» */
  title?: string;
  /** сниппет ответа — только при платной опции кабинета */
  snippet?: string;
  /** URL источника ответа — только при платной опции кабинета */
  url?: string;
}

export interface RelatedQuestionsResult {
  questions: RelatedQuestion[];
  count: number;
  /** true — PAA-блока нет (код 15), запрос при этом тарифицирован */
  empty?: true;
  /** false — title/snippet/url пустые у всех вопросов (опция кабинета не включена) */
  answers_available: boolean;
  note?: string;
}

/**
 * Разбор response/relatedQuestions/item[]. question обязателен (item без текста вопроса
 * отбрасывается); title/snippet/url — опциональны: пустые строки (без платной опции
 * кабинета) превращаются в undefined, а не в «».
 */
export function parseRelatedQuestions(doc: any): RelatedQuestion[] {
  const items = asArray<any>(doc?.yandexsearch?.response?.relatedQuestions?.item);
  const questions: RelatedQuestion[] = [];
  for (const it of items) {
    // question — stopNode shared-парсера: значение — сырая строка (возможен CDATA)
    const question = stripTags(typeof it === 'string' ? it : String(it?.question ?? ''));
    if (!question) continue;
    const q: RelatedQuestion = { question };
    const title = stripTags(String(it?.title ?? ''));
    const snippet = stripTags(String(it?.snippet ?? ''));
    const url = stripTags(String(it?.url ?? ''));
    if (title) q.title = title;
    if (snippet) q.snippet = snippet;
    if (url) q.url = url;
    questions.push(q);
  }
  return questions;
}

/**
 * Один GET setab=rq. count — обязательный параметр API (валидируется zod в index.ts: 1–50).
 * Код 15 (нет PAA-блока) → empty: true, запрос тарифицирован (списание трекает xmlriverGet).
 */
export async function collectRelatedQuestions(
  query: string,
  count: number,
  region?: string,
  device?: 'desktop' | 'mobile',
  account?: string,
): Promise<RelatedQuestionsResult> {
  const params: Record<string, string | number | undefined> = { setab: 'rq', count, query };
  const lr = resolveLr(region);
  if (lr !== undefined) params.lr = lr;
  if (device) params.device = device;

  const doc = await xmlriverGet(GOOGLE_URL, params, account);
  if (isEmptySerp(doc)) {
    return {
      questions: [],
      count: 0,
      empty: true,
      answers_available: false,
      note: 'нет блока «Вопросы по теме» (код 15), запрос тарифицирован',
    };
  }

  const questions = parseRelatedQuestions(doc);
  // ответы считаем доступными, если хотя бы у одного вопроса заполнен title —
  // иначе пользователь не отличит «опция не включена» от «у Google нет ответа»
  const answersAvailable = questions.some((q) => q.title);
  return {
    questions,
    count: questions.length,
    answers_available: answersAvailable,
    ...(!answersAvailable && questions.length > 0
      ? {
          note: 'title/snippet/url пустые — для ответов включите платную опцию «Related Questions с ответами» в кабинете XMLRiver (настройки сбора); вопросы доступны и без неё',
        }
      : {}),
  };
}
