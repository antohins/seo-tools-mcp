import { describe, it, expect } from 'vitest';
import { isDeadGrant } from '../shared/src/yandex-oauth.js';
import { HttpError } from '../shared/src/http.js';

const httpErr = (status: number, body: string) => new HttpError(status, 'https://oauth.yandex.ru/token', body);

describe('isDeadGrant', () => {
  it('invalid_grant / invalid_client / unauthorized_client → мёртв', () => {
    expect(isDeadGrant(httpErr(400, '{"error":"invalid_grant"}'))).toBe(true);
    expect(isDeadGrant(httpErr(400, '{"error":"invalid_client"}'))).toBe(true);
    expect(isDeadGrant(httpErr(401, '{"error":"unauthorized_client"}'))).toBe(true);
  });

  it('4xx без OAuth-кода в теле (прокси) → транзиент', () => {
    expect(isDeadGrant(httpErr(403, '<html>Forbidden</html>'))).toBe(false);
    expect(isDeadGrant(httpErr(400, 'Bad Request'))).toBe(false);
  });

  it('408 / 429 → транзиент, даже с кодом в теле', () => {
    expect(isDeadGrant(httpErr(408, '{"error":"invalid_grant"}'))).toBe(false);
    expect(isDeadGrant(httpErr(429, '{"error":"invalid_grant"}'))).toBe(false);
  });

  it('5xx → транзиент', () => {
    expect(isDeadGrant(httpErr(500, 'err'))).toBe(false);
    expect(isDeadGrant(httpErr(503, 'unavailable'))).toBe(false);
  });

  it('сеть/timeout (не HttpError) → транзиент', () => {
    expect(isDeadGrant(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(false);
    expect(isDeadGrant(new TypeError('fetch failed'))).toBe(false);
  });
});
