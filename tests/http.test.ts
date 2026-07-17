import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchText, HttpError } from '../shared/src/http.js';

function fakeRes(status: number, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchText retries', () => {
  it('ретраит 5xx и возвращает тело при успехе', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(fakeRes(503, 'busy'))
      .mockResolvedValueOnce(fakeRes(200, 'ok'));
    vi.stubGlobal('fetch', fetch);
    const text = await fetchText('https://x.test/', { backoffMs: 1 });
    expect(text).toBe('ok');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('исчерпание попыток → HttpError с последним статусом', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes(500, 'boom'));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchText('https://x.test/', { attempts: 2, backoffMs: 1 }))
      .rejects.toMatchObject({ status: 500 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('4xx не ретраится по умолчанию', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes(404, 'nf'));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchText('https://x.test/', { backoffMs: 1 })).rejects.toBeInstanceOf(HttpError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retryOn переопределяет: ретраит 418, игнорит 500', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(fakeRes(418, 'teapot'))
      .mockResolvedValueOnce(fakeRes(200, 'done'));
    vi.stubGlobal('fetch', fetch);
    const text = await fetchText('https://x.test/', { backoffMs: 1, retryOn: (s) => s === 418 });
    expect(text).toBe('done');

    const fetch2 = vi.fn().mockResolvedValue(fakeRes(500, 'x'));
    vi.stubGlobal('fetch', fetch2);
    await expect(fetchText('https://x.test/', { backoffMs: 1, retryOn: (s) => s === 418 }))
      .rejects.toMatchObject({ status: 500 });
    expect(fetch2).toHaveBeenCalledTimes(1); // не ретраит
  });
});
