import { describe, expect, it } from 'vitest';
import { envKey, maskSecret, maskUrl, validateAccount } from '../shared/src/config.js';
import { HttpError } from '../shared/src/http.js';
import { resolveRegionId, resolveRegionIds, YANDEX_REGIONS } from '../shared/src/yandex-regions.js';

describe('maskUrl', () => {
  it('маскирует секретные query-параметры', () => {
    expect(maskUrl('https://xmlstock.com/?user=1&key=SECRET&query=cats')).toBe(
      'https://xmlstock.com/?user=REDACTED&key=REDACTED&query=cats',
    );
  });
  it('маскирует userinfo (basic-auth)', () => {
    expect(maskUrl('https://u:p@host.com/x')).toBe('https://REDACTED:REDACTED@host.com/x');
  });
  it('маскирует client_secret/refresh_token', () => {
    expect(maskUrl('https://oauth.yandex.ru/token?client_secret=CS&refresh_token=RT')).toBe(
      'https://oauth.yandex.ru/token?client_secret=REDACTED&refresh_token=REDACTED',
    );
  });
  it('не трогает несекретный URL', () => {
    const u = 'https://example.com/page?p=2';
    expect(maskUrl(u)).toBe(u);
  });
  it('не-URL возвращает как есть', () => {
    expect(maskUrl('not a url')).toBe('not a url');
  });
});

describe('maskSecret', () => {
  it('короткий секрет полностью скрыт', () => {
    expect(maskSecret('short')).toBe('••••');
  });
  it('длинный — начало…конец (N симв.)', () => {
    expect(maskSecret('abcdefghijkl')).toBe('abc…jkl (12 симв.)');
  });
  it('пустой → null', () => {
    expect(maskSecret(undefined)).toBeNull();
    expect(maskSecret('')).toBeNull();
  });
});

describe('HttpError', () => {
  it('.message и .url маскируют секрет; .rawUrl — сырой', () => {
    const e = new HttpError(429, 'https://xmlstock.com/?user=1&key=SECRET', 'rate limited');
    expect(e.status).toBe(429);
    expect(e.url).toBe('https://xmlstock.com/?user=REDACTED&key=REDACTED');
    expect(e.rawUrl).toBe('https://xmlstock.com/?user=1&key=SECRET');
    expect(e.message).not.toContain('SECRET');
    expect(e.bodySnippet).toBe('rate limited');
  });
});

describe('validateAccount / envKey', () => {
  it('пустой/undefined → основной профиль (undefined)', () => {
    expect(validateAccount(undefined)).toBeUndefined();
    expect(validateAccount('')).toBeUndefined();
  });
  it('валидное имя проходит', () => {
    expect(validateAccount('client_1-x')).toBe('client_1-x');
  });
  it('недопустимое имя бросает', () => {
    expect(() => validateAccount('bad name!')).toThrow();
    expect(() => validateAccount('a'.repeat(33))).toThrow();
  });
  it('envKey добавляет суффикс профиля', () => {
    expect(envKey('YANDEX_OAUTH_TOKEN')).toBe('YANDEX_OAUTH_TOKEN');
    expect(envKey('YANDEX_OAUTH_TOKEN', 'client1')).toBe('YANDEX_OAUTH_TOKEN__client1');
  });
});

describe('yandex-regions', () => {
  it('имя региона → id', () => {
    expect(resolveRegionId('Москва')).toBe(213);
    expect(resolveRegionId('россия')).toBe(YANDEX_REGIONS.россия);
  });
  it('числовой id пропускается как есть', () => {
    expect(resolveRegionId('213')).toBe(213);
  });
  it('undefined → undefined (все регионы)', () => {
    expect(resolveRegionId(undefined)).toBeUndefined();
    expect(resolveRegionIds(undefined)).toBeUndefined();
  });
  it('список через запятую с пробелами', () => {
    expect(resolveRegionIds('Москва, Санкт-Петербург')).toEqual(['213', '2']);
    expect(resolveRegionIds('213,2')).toEqual(['213', '2']);
  });
  it('алиасы и расширенный список городов', () => {
    expect(resolveRegionId('спб')).toBe(2);
    expect(resolveRegionId('МСК')).toBe(213);
    expect(resolveRegionId('Казахстан')).toBe(159);
    expect(resolveRegionId('Нижний Новгород')).toBe(47);
    expect(resolveRegionIds('екб, питер')).toEqual(['54', '2']);
  });
  it('неизвестный регион бросает', () => {
    expect(() => resolveRegionId('Атлантида')).toThrow(/Неизвестный регион/);
  });
});
