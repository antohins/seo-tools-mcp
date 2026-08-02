import { afterEach, describe, expect, it, vi } from 'vitest';
import { BODY_SNIPPET_LIMIT, fetchText, HttpError, MAX_RETRY_AFTER_MS } from '../shared/src/http.js';

function fakeRes(status: number, body = '', headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fetchText: Retry-After', () => {
  it('ограничен потолком MAX_RETRY_AFTER_MS', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(fakeRes(429, 'slow', { 'retry-after': '3600' }))
      .mockResolvedValueOnce(fakeRes(200, 'ok'));
    vi.stubGlobal('fetch', fetch);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const p = fetchText('https://x.test/', { attempts: 2, backoffMs: 1, timeoutMs: 300_000 });
    await vi.advanceTimersByTimeAsync(MAX_RETRY_AFTER_MS + 1);
    await expect(p).resolves.toBe('ok');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining(`in ${MAX_RETRY_AFTER_MS}ms`));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('fetchText: финальные ошибки с контекстом', () => {
  it('таймаут: ошибка с маскированным URL, величиной таймаута и числом попыток', async () => {
    const fetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
        }),
    );
    vi.stubGlobal('fetch', fetch);

    const err: Error = await fetchText('https://x.test/?key=SECRET&q=ok', { attempts: 1, timeoutMs: 50 }).then(
      () => {
        throw new Error('ожидался reject');
      },
      (e) => e,
    );
    expect(err.message).toContain('таймаут 50 мс');
    expect(err.message).toContain('после 1 попыток');
    expect(err.message).toContain('https://x.test/?key=REDACTED&q=ok');
    expect(err.message).not.toContain('SECRET');
  });

  it('сетевая ошибка: ошибка с маскированным URL и числом попыток', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const err: Error = await fetchText('https://x.test/?token=SECRET', { attempts: 2, backoffMs: 1, timeoutMs: 1000 }).then(
      () => {
        throw new Error('ожидался reject');
      },
      (e) => e,
    );
    expect(err.message).toContain('сетевая ошибка');
    expect(err.message).toContain('после 2 попыток');
    expect(err.message).toContain('token=REDACTED');
    expect(err.message).not.toContain('SECRET');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('HttpError: bodySnippet', () => {
  it('маскирует секретные «ключ=значение» в теле ответа', () => {
    const e = new HttpError(400, 'https://x.test/', 'bad request at /?user=XXX&key=YYY&q=ok');
    expect(e.bodySnippet).toContain('user=REDACTED');
    expect(e.bodySnippet).toContain('key=REDACTED');
    expect(e.bodySnippet).toContain('q=ok');
    expect(e.bodySnippet).not.toContain('XXX');
    expect(e.message).not.toContain('YYY');
  });
  it('обрезает тело до лимита', () => {
    const e = new HttpError(502, 'https://x.test/', 'a'.repeat(10_000));
    expect(e.bodySnippet.length).toBe(BODY_SNIPPET_LIMIT);
  });
});
