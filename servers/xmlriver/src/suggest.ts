/**
 * Сбор поисковых подсказок Google через XMLRiver (setab=tips) — вынесен из index.ts ради юнит-тестов.
 * Лайв-подтверждено (2026-08, user=7691):
 *  - POST https://xmlriver.com/search/xml?setab=tips&user&key с JSON-телом {"phrases":[...]},
 *    от 1 до 50 фраз за запрос;
 *  - ответ — JSON {"phrases":[...]}: ПЛОСКИЙ массив, ~10 подсказок на входную фразу,
 *    конкатенированы в порядке входных фраз;
 *  - тарификация ЗА КАЖДУЮ фразу (50 фраз = 50 списаний) — по доке api-tips;
 *  - ошибки — HTTP 200 с JSON {"code","error"} (напр. code 3 — «Ошибка парсинга JSON запроса
 *    или запрос пустой»); деньги за ошибку не списываем (cost.track не вызываем);
 *  - доп. URL-параметры гео/языка: loc, country, lr (поддержан только lr — как в xmlriver_serp).
 */
import { fetchText, requireEnv } from '@seo-tools/shared';
import { z } from 'zod';
import { cost, GOOGLE_URL, resolveLr } from './serp.js';

/** Лимит API: 1–50 фраз за запрос (списание за каждую). */
export const suggestPhrasesSchema = z
  .array(z.string().min(1))
  .min(1, 'нужна хотя бы одна фраза')
  .max(50, 'XMLRiver принимает до 50 фраз за запрос (списание идёт за каждую)');

export interface SuggestResult {
  /** плоский список подсказок, как отдал API (порядок следует входным фразам) */
  phrases: string[];
  /** группировка по входным фразам — только если подсказок поровну на фразу (типично 10) */
  byPhrase: Record<string, string[]> | null;
  /** пояснение, когда группировка недоступна */
  note?: string;
  count: number;
  /** сколько фраз тарифицировано (= числу входных фраз) */
  charged: number;
}

/**
 * Раскладывает плоский список подсказок по входным фразам равными чанками.
 * Группировка возможна только если suggestions делится на inputs нацело (типично 10 на фразу);
 * иначе byPhrase=null — порядок плоского списка всё равно следует входным фразам.
 */
export function groupByPhrase(suggestions: string[], inputs: string[]): Pick<SuggestResult, 'byPhrase' | 'note'> {
  if (suggestions.length % inputs.length !== 0) {
    return { byPhrase: null, note: 'группировка недоступна, порядок следует входным фразам' };
  }
  const per = suggestions.length / inputs.length;
  const byPhrase: Record<string, string[]> = {};
  inputs.forEach((phrase, i) => {
    byPhrase[phrase] = suggestions.slice(i * per, (i + 1) * per);
  });
  return { byPhrase };
}

/**
 * Один POST setab=tips на пачку фраз. HTTP-ретраи/таймаут — как у xmlriverGet (fetchText);
 * JSON-ошибка {"code","error"} и не-JSON ответ — понятный throw БЕЗ списания.
 */
export async function collectSuggest(phrases: string[], region?: string, account?: string): Promise<SuggestResult> {
  const user = requireEnv('XMLRIVER_USER', account);
  const key = requireEnv('XMLRIVER_KEY', account);
  const qs = new URLSearchParams({ user, key, setab: 'tips' });
  const lr = resolveLr(region);
  if (lr !== undefined) qs.set('lr', String(lr));
  const url = `${GOOGLE_URL}?${qs}`;

  const text = await fetchText(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phrases }),
    timeoutMs: 90_000,
  });

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    // HTML-заглушка (обычно неверные ключи) — НЕ тарифицируем, как и в xmlriverGet
    throw new Error(
      'XMLRiver вернул не-JSON/невалидный ответ — вероятно неверные XMLRIVER_USER/XMLRIVER_KEY (xmlriver_set_credentials / xmlriver_auth_status).',
    );
  }
  // JSON-ошибка API (HTTP 200): {"code":"3","error":"..."} — деньги не списаны, трека нет
  if (data && typeof data === 'object' && typeof data.error === 'string') {
    throw new Error(`XMLRiver error ${data.code}: ${data.error}`);
  }
  const suggestions = Array.isArray(data?.phrases) ? (data.phrases as unknown[]).filter((s): s is string => typeof s === 'string') : null;
  if (!suggestions) {
    throw new Error(`XMLRiver вернул не-JSON/невалидный ответ (нет массива phrases): ${text.slice(0, 200)}`);
  }

  // оплата за КАЖДУЮ фразу — трекаем одним вызовом с units=число фраз
  cost.track(`suggest (${phrases.length} фраз)`, phrases.length);
  return {
    phrases: suggestions,
    ...groupByPhrase(suggestions, phrases),
    count: suggestions.length,
    charged: phrases.length,
  };
}
