/**
 * Персистентный конфиг: ~/.config/seo-tools-mcp/.env (права 600).
 *
 * Модель чтения (фикс stale-значений между процессами):
 *  - initialEnv — снапшот РЕАЛЬНОГО окружения процесса на старте (claude mcp add --env,
 *    экспорт шелла); имеет приоритет и не меняется;
 *  - всё остальное читается из файла через mtime-кеш при КАЖДОМ обращении (getConfig) —
 *    токен, ротированный соседним процессом, виден сразу, без рестарта.
 *
 * Запись (saveEnvValues) — атомарная: lock-каталог (best effort) → свежее чтение файла →
 * upsert → tmp-файл → rename. Конкурентные записи из разных серверных процессов не теряются.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const ENV_FILE = process.env.SEO_TOOLS_MCP_ENV || join(homedir(), '.config', 'seo-tools-mcp', '.env');
export const CONFIG_DIR = dirname(ENV_FILE);

// снапшот реального окружения — ДО каких-либо чтений конфига
const initialEnv: Record<string, string | undefined> = { ...process.env };

let fileCache: Map<string, string> | null = null;
let fileMtimeMs = -1;

function parseEnvText(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !map.has(key)) map.set(key, value); // при дублях выигрывает первая строка
  }
  return map;
}

/** Содержимое env-файла с кешем по mtime; force — перечитать безусловно. */
export function readConfigFile(force = false): Map<string, string> {
  try {
    const st = statSync(ENV_FILE);
    if (!force && fileCache && st.mtimeMs === fileMtimeMs) return fileCache;
    fileCache = parseEnvText(readFileSync(ENV_FILE, 'utf8'));
    fileMtimeMs = st.mtimeMs;
  } catch {
    fileCache = new Map();
    fileMtimeMs = -1;
  }
  return fileCache;
}

/**
 * Значение конфига: реальное окружение процесса (initialEnv) > env-файл (свежий).
 * Единственная точка чтения — НЕ читать process.env напрямую в серверах.
 */
export function getConfig(name: string, account?: string): string | undefined {
  const key = envKey(name, account);
  return initialEnv[key] || readConfigFile().get(key) || undefined;
}

/** true, если ключ перекрыт реальным окружением процесса (файл его не изменит). */
export function hasRealEnvOverride(name: string, account?: string): boolean {
  return Boolean(initialEnv[envKey(name, account)]);
}

const sleepSync = (ms: number) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* среда без SharedArrayBuffer — пропускаем паузу */
  }
};

/** Апсертит значения в env-файл атомарно (lock → fresh read → tmp → rename). */
export function saveEnvValues(values: Record<string, string>): string {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });

  // лок best-effort: каталог-семафор, ждём до 2 с, дальше пишем всё равно
  const lockDir = `${ENV_FILE}.lock`;
  const deadline = Date.now() + 2000;
  let locked = false;
  for (;;) {
    try {
      mkdirSync(lockDir);
      locked = true;
      break;
    } catch {
      if (Date.now() > deadline) break;
      sleepSync(20);
    }
  }

  try {
    // свежее чтение с диска (мимо кеша) — чтобы не затереть запись соседнего процесса
    const lines: string[] = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split('\n') : [];
    for (const [key, value] of Object.entries(values)) {
      if (!value) continue;
      const line = `${key}=${value}`;
      // матчим и стиль «KEY = value» (пробелы вокруг =), который loadSharedEnv читает валидно
      const re = new RegExp(`^\\s*${key}\\s*=`);
      const idx = lines.findIndex((l) => re.test(l));
      if (idx >= 0) lines[idx] = line;
      else lines.push(line);
    }
    const tmp = `${ENV_FILE}.tmp.${process.pid}`;
    writeFileSync(tmp, lines.join('\n').replace(/\n+$/, '') + '\n', { mode: 0o600 });
    renameSync(tmp, ENV_FILE);
    chmodSync(ENV_FILE, 0o600);
    fileCache = null; // инвалидация кеша — следующий getConfig прочитает свежее
    return ENV_FILE;
  } finally {
    if (locked) {
      try {
        rmdirSync(lockDir);
      } catch {
        /* уже снят */
      }
    }
  }
}

/** Маскирует секрет для вывода в статусе: abc…xyz (NN симв.). */
export function maskSecret(v: string | undefined): string | null {
  if (!v) return null;
  if (v.length <= 8) return '••••';
  return `${v.slice(0, 3)}…${v.slice(-3)} (${v.length} симв.)`;
}

/** Имена query-параметров, значения которых нельзя писать в логи. */
const SECRET_PARAM_RE =
  /^(key|apikey|api_key|token|access_token|refresh_token|password|passwd|pass|pwd|secret|client_secret|user|auth|sign)$/i;

/**
 * Маскирует секреты в URL перед логированием: значения секретных query-параметров
 * (часть провайдеров, например xmlstock, кладёт ключ/логин прямо в query) и
 * userinfo (basic-auth `user:pass@host`). Хост/путь/фрагмент не трогаем —
 * секрет, зашитый в path, эта функция НЕ распознаёт (провайдер-специфично).
 */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    let changed = false;
    if (u.username) {
      u.username = 'REDACTED';
      changed = true;
    }
    if (u.password) {
      u.password = 'REDACTED';
      changed = true;
    }
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_PARAM_RE.test(k)) {
        u.searchParams.set(k, 'REDACTED');
        changed = true;
      }
    }
    return changed ? u.toString() : raw;
  } catch {
    return raw; // не парсится как URL — возвращаем как есть
  }
}

// ── Мультиаккаунт: именованные профили через суффикс env-ключа (NAME__account) ──

const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Валидирует имя аккаунта-профиля; undefined/'' = основной профиль. */
export function validateAccount(account?: string): string | undefined {
  if (account === undefined || account === '') return undefined;
  if (!ACCOUNT_RE.test(account)) {
    throw new Error(`Недопустимое имя аккаунта «${account}» — латиница/цифры/дефис/подчёркивание, до 32 символов`);
  }
  return account;
}

/** Имя env-переменной с учётом аккаунта: envKey('GSC_REFRESH_TOKEN','client1') → GSC_REFRESH_TOKEN__client1. */
export function envKey(name: string, account?: string): string {
  const acc = validateAccount(account);
  return acc ? `${name}__${acc}` : name;
}

/** Список аккаунтов, для которых задана переменная name (в окружении или файле). */
export function accountsFor(name: string): string[] {
  const prefix = `${name}__`;
  const found = new Set<string>();
  for (const k of Object.keys(initialEnv)) {
    if (k.startsWith(prefix) && initialEnv[k]) found.add(k.slice(prefix.length));
  }
  for (const k of readConfigFile().keys()) {
    if (k.startsWith(prefix) && readConfigFile().get(k)) found.add(k.slice(prefix.length));
  }
  return [...found].sort();
}
