/**
 * Loopback-приёмник OAuth-кода Google (вынесен из index.ts ради юнит-тестов).
 * Ловит редирект на localhost; код привязан к конкретному flow (state + профиль) —
 * чужой/устаревший код не подхватится. Listener живёт между flow (порт не переоткрывается),
 * поэтому таймер авто-закрытия ПЕРЕВЗВОДИТСЯ на каждом start(): иначе таймер
 * брошенного flow (без finish) сработал бы посреди следующего flow и убил бы его listener.
 */
import { createServer, type Server } from 'node:http';

export interface OauthFlow {
  account: string | null;
  state: string;
  code: string | null;
}

export interface LoopbackManager {
  /** Поднимает приёмник (или перевзводит его таймер); false — порт занят. */
  start(): Promise<boolean>;
  /** Гасит таймер и закрывает listener. */
  stop(): void;
  /** Listener жив (для тестов/диагностики). */
  running(): boolean;
}

export function createLoopbackManager(opts: {
  port: number;
  redirectUri: string;
  getFlow: () => OauthFlow | null;
  autoCloseMs?: number;
}): LoopbackManager {
  const autoCloseMs = opts.autoCloseMs ?? 10 * 60_000;
  let loopback: Server | null = null;
  let loopbackTimer: ReturnType<typeof setTimeout> | null = null;

  const stop = (): void => {
    // обязательно гасим таймер авто-закрытия: иначе таймер ЗАВЕРШЁННОГО flow1
    // сработает позже и убьёт listener уже активного flow2
    if (loopbackTimer) {
      clearTimeout(loopbackTimer);
      loopbackTimer = null;
    }
    loopback?.close();
    loopback = null;
  };

  /** Взводит таймер авто-закрытия заново (перевзвод при переиспользовании listener — суть фикса). */
  const armTimer = (): void => {
    if (loopbackTimer) clearTimeout(loopbackTimer);
    loopbackTimer = setTimeout(stop, autoCloseMs);
    loopbackTimer.unref();
  };

  /** false — порт занят (EADDRINUSE приходит асинхронно, поэтому ждём listening/error). */
  const start = (): Promise<boolean> => {
    if (loopback) {
      armTimer(); // listener переиспользуется новым flow — отмеряем 10 минут ЗАНОВО от этого flow
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const srv = createServer((req, res) => {
        const url = new URL(req.url ?? '/', opts.redirectUri);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const flow = opts.getFlow();
        const matches = Boolean(code) && Boolean(flow) && state === flow!.state;
        if (matches) flow!.code = code;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          matches
            ? '<h2>Код получен ✓</h2><p>Вернись в чат и вызови gsc_oauth_finish (код подхватится автоматически).</p>'
            : '<h2>Код не принят</h2><p>Этот редирект не относится к текущей авторизации — повтори gsc_oauth_start и используй свежую ссылку.</p>',
        );
      });
      srv.once('error', () => {
        loopback = null;
        resolve(false); // порт занят — сообщаем честно, oauth_start даст ручную инструкцию
      });
      srv.once('listening', () => {
        loopback = srv;
        armTimer();
        resolve(true);
      });
      srv.listen(opts.port, '127.0.0.1');
    });
  };

  return { start, stop, running: () => loopback !== null };
}
