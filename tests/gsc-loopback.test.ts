import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoopbackManager, type OauthFlow } from '../servers/gsc/src/loopback.js';

// Таймер авто-закрытия loopback-приёмника: при переиспользовании listener новым flow
// таймер ПЕРЕВЗВОДИТСЯ (баг: таймер брошенного flow1 убивал listener активного flow2),
// stop() таймер гасит. Слушаем ephemeral-порт (127.0.0.1:0) — внешняя сеть не нужна.

const AUTO_CLOSE_MS = 10 * 60_000;

let flow: OauthFlow | null;
let mgr: ReturnType<typeof createLoopbackManager>;

beforeEach(() => {
  vi.useFakeTimers();
  flow = null;
  mgr = createLoopbackManager({
    port: 0, // ephemeral — свободный порт выберет ОС
    redirectUri: 'http://localhost:0',
    getFlow: () => flow,
    autoCloseMs: AUTO_CLOSE_MS,
  });
});

afterEach(() => {
  mgr.stop();
  vi.useRealTimers();
});

describe('gsc loopback: таймер авто-закрытия', () => {
  it('повторный start() перевзводит таймер: таймер прежнего flow не убивает listener нового', async () => {
    expect(await mgr.start()).toBe(true);
    expect(mgr.running()).toBe(true);

    // flow1 «брошен» (finish не вызван, stop() не было): его таймер всё ещё ticking
    await vi.advanceTimersByTimeAsync(AUTO_CLOSE_MS - 1000); // до срабатывания таймера flow1 — 1 с

    // flow2 переиспользует живой listener → таймер перевзводится заново
    flow = { account: null, state: 's2', code: null };
    expect(await mgr.start()).toBe(true);

    // момент старого таймера проходит — listener должен ВЫЖИТЬ (перевзвод)
    await vi.advanceTimersByTimeAsync(2000);
    expect(mgr.running()).toBe(true);

    // остаток нового срока (10 мин с перевзвода) — авто-закрытие наконец срабатывает
    await vi.advanceTimersByTimeAsync(AUTO_CLOSE_MS);
    expect(mgr.running()).toBe(false);
  });

  it('без перевзвода listener умирает ровно по таймеру авто-закрытия', async () => {
    expect(await mgr.start()).toBe(true);
    await vi.advanceTimersByTimeAsync(AUTO_CLOSE_MS - 1);
    expect(mgr.running()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(mgr.running()).toBe(false);
  });

  it('stop() гасит таймер: после stop + 10 мин ничего не происходит, повторный stop безопасен', async () => {
    expect(await mgr.start()).toBe(true);
    mgr.stop();
    expect(mgr.running()).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTO_CLOSE_MS * 2); // таймер не воскресает, двойной close не падает
    expect(mgr.running()).toBe(false);
    expect(await mgr.start()).toBe(true); // сервер поднимается заново без ошибок
    mgr.stop();
  });
});
