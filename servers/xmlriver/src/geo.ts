/**
 * Гео-таргетинг Google в XMLRiver (вынесен из index.ts ради юнит-тестов).
 * Лайв-подтверждено (2026-08, user=7691):
 *  - loc — числовой Google criteria ID местоположения: loc=1011969 (Москва) и
 *    loc=1012040 (СПб) дают географически разную выдачу;
 *  - country — числовой id страны XMLRiver (country=2643 = RU): в связке с loc
 *    даёт чисто региональную выдачу, принимается и отдельно;
 *  - domain — по доке числовой id (google.ru = 143); строка 'ru' тоже принимается
 *    (старое поведение), но дока требует число — маппим через domains.json.
 *
 * Справочники XMLRiver (https://xmlriver.com/apidoc/api-about/):
 *  - geo.csv (~5 МБ, ~100K строк): Criteria ID,Name,Canonical Name,Parent ID,
 *    Country Code,Target Type,Status — резолв имени города → criteria ID;
 *  - countries.xlsx / domains.xlsx — сконвертированы в ./data.js
 *    (COUNTRIES: ISO → id, RU=2643; DOMAINS: домен → id, ru=143, com=37).
 *
 * geo.csv скачивается ОДИН раз и кэшируется на диске в
 * <CONFIG_DIR>/cache/xmlriver-geo.csv (рядом с ~/.config/seo-tools-mcp/.env),
 * TTL 7 дней; параллельные вызовы дедуплицируются in-flight промисом
 * (паттерн createRegionNamesCache из xmlstock/wordstat.ts).
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_DIR, fetchText } from '@seo-tools/shared';
import { COUNTRIES, DOMAINS } from './data.js';

export const GEO_CSV_URL = 'https://xmlriver.com/files/geo.csv';
export const GEO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней

const COUNTRY_IDS = COUNTRIES;
const DOMAIN_IDS = DOMAINS;
// обратный маппинг id → ISO: нужен для дизамбигуации города, когда country задан числом
const ISO_BY_ID = new Map<number, string>(Object.entries(COUNTRY_IDS).map(([iso, id]) => [id, iso]));

/**
 * Страна → числовой id XMLRiver: число — как есть, ISO-код (2 буквы, регистр не важен) —
 * через countries.json. Неизвестное значение — понятная ошибка со ссылкой на справочник.
 */
export function resolveCountry(input?: string): number | undefined {
  if (!input?.trim()) return undefined;
  const t = input.trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (/^[A-Za-z]{2}$/.test(t)) {
    const id = COUNTRY_IDS[t.toUpperCase()];
    if (id !== undefined) return id;
  }
  throw new Error(
    `country «${input}» не распознан: укажите ISO-код из 2 букв (например RU, US) или числовой id страны XMLRiver ` +
      '(справочник — https://xmlriver.com/files/countries.xlsx).',
  );
}

/** ISO-код страны из входа (строка ISO или числовой id через обратный маппинг); неизвестное → undefined. */
function resolveCountryIso(input?: string): string | undefined {
  if (!input) return undefined;
  const t = input.trim();
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  if (/^\d+$/.test(t)) return ISO_BY_ID.get(Number(t));
  return undefined;
}

/**
 * searchDomain → числовой id домена XMLRiver (ru → 143, com → 37) через domains.json.
 * Неизвестный домен возвращается строкой как есть — обратная совместимость: API её принимает.
 */
export function resolveDomainId(domain: string): string | number {
  return DOMAIN_IDS[domain.toLowerCase()] ?? domain;
}

export interface GeoEntry {
  /** Google criteria ID (колонка Criteria ID) */
  id: number;
  /** ISO-код страны (колонка Country Code) */
  countryCode: string;
}

/** Разбор одной CSV-строки с учётом кавычек (Canonical Name содержит запятые). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * geo.csv → индекс name.toLowerCase() → список совпадений (имена не уникальны:
 * «Moscow» есть и в России, и в США). Берём только строки со Status=Active.
 */
export function parseGeoCsv(csv: string): Map<string, GeoEntry[]> {
  const map = new Map<string, GeoEntry[]>();
  const lines = csv.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    const id = Number(cols[0]);
    const name = (cols[1] ?? '').trim();
    const countryCode = (cols[4] ?? '').trim();
    const status = (cols[6] ?? '').trim();
    if (!Number.isFinite(id) || !name || status !== 'Active') continue;
    const key = name.toLowerCase();
    const entry: GeoEntry = { id, countryCode };
    const arr = map.get(key);
    if (arr) arr.push(entry);
    else map.set(key, [entry]);
  }
  return map;
}

/**
 * Загрузчик индекса geo.csv: in-memory кэш → дисковый кэш (mtime, TTL) → сеть.
 * In-flight промис дедуплицирует параллельные вызовы при холодном кэше
 * (без него каждый потянул бы свои ~5 МБ). Дисковая запись атомарная (tmp + rename).
 */
export function createGeoIndexLoader(opts: {
  cacheFile: string;
  ttlMs?: number;
  fetchCsv?: () => Promise<string>;
}): () => Promise<Map<string, GeoEntry[]>> {
  const ttl = opts.ttlMs ?? GEO_CACHE_TTL_MS;
  const fetchCsv = opts.fetchCsv ?? (() => fetchText(GEO_CSV_URL, { timeoutMs: 120_000 }));
  let mem: { index: Map<string, GeoEntry[]>; ts: number } | null = null;
  let inflight: Promise<Map<string, GeoEntry[]>> | null = null;
  return async () => {
    if (mem && Date.now() - mem.ts < ttl) return mem.index;
    if (inflight) return inflight;
    inflight = (async () => {
      // свежий файл на диске — сеть не нужна (mtime файла = время скачивания)
      try {
        const st = statSync(opts.cacheFile);
        if (Date.now() - st.mtimeMs < ttl) {
          const index = parseGeoCsv(readFileSync(opts.cacheFile, 'utf8'));
          mem = { index, ts: st.mtimeMs };
          return index;
        }
      } catch {
        /* файла нет или не читается — скачиваем */
      }
      const csv = await fetchCsv();
      mkdirSync(dirname(opts.cacheFile), { recursive: true });
      const tmp = `${opts.cacheFile}.tmp.${process.pid}`;
      writeFileSync(tmp, csv);
      renameSync(tmp, opts.cacheFile);
      const index = parseGeoCsv(csv);
      mem = { index, ts: Date.now() };
      return index;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

// кэш рядом с конфигом: ~/.config/seo-tools-mcp/cache/xmlriver-geo.csv
const loadGeoIndex = createGeoIndexLoader({ cacheFile: join(CONFIG_DIR, 'cache', 'xmlriver-geo.csv') });

export interface GeoParams {
  /** Google criteria ID местоположения (URL-параметр loc) */
  loc?: number;
  /** числовой id страны XMLRiver (URL-параметр country): явный либо выведенный из города */
  country?: number;
  /** пояснение при неоднозначности имени города */
  note?: string;
}

/**
 * Общий резолв гео-параметров Google для хендлеров: location → loc (+ автовывод country
 * из города), явный country перекрывает автовывод; country без location — отдельно.
 * Оба входа пустые → undefined (гео не задано, поле geo в ответе не эхим).
 */
export async function resolveGeo(location?: string, country?: string): Promise<GeoParams | undefined> {
  if (location) return resolveLocation(location, country);
  if (country) return { country: resolveCountry(country) };
  return undefined;
}

export interface ResolvedGeo {
  /** Google criteria ID местоположения (URL-параметр loc) */
  loc: number;
  /** числовой id страны XMLRiver (URL-параметр country): явный либо выведенный из города */
  country?: number;
  /** пояснение при неоднозначности имени города */
  note?: string;
}

/**
 * location → { loc, country }: числовой criteria ID — напрямую без сети (country только явный);
 * строка — имя города (англ.), резолв через geo.csv. При нескольких совпадениях имени
 * предпочитается совпадение по country (если задан), иначе первое + note про неоднозначность.
 * country выводится автоматически из строки geo.csv (Country Code → countries.json);
 * явный country (ISO или число) перекрывает автовывод.
 */
export async function resolveLocation(input: string, country?: string): Promise<ResolvedGeo> {
  const t = input.trim();
  if (!t) {
    throw new Error('location: пустое значение — укажите город («Moscow») или числовой Google criteria ID («1011969»)');
  }
  // валидируем явный country сразу — мусор должен падать понятной ошибкой и без сети
  const explicitCountry = resolveCountry(country);
  if (/^\d+$/.test(t)) {
    return explicitCountry !== undefined ? { loc: Number(t), country: explicitCountry } : { loc: Number(t) };
  }
  const index = await loadGeoIndex();
  const matches = index.get(t.toLowerCase());
  if (!matches?.length) {
    throw new Error(
      `Город «${input}» не найден в справочнике geo.csv XMLRiver (нужно английское название, напр. «Moscow»). ` +
        `Задайте числовой Google criteria ID напрямую или найдите город в справочнике: ${GEO_CSV_URL}`,
    );
  }
  let entry = matches[0];
  let note: string | undefined;
  if (matches.length > 1) {
    const iso = resolveCountryIso(country);
    const byCountry = iso ? matches.find((m) => m.countryCode === iso) : undefined;
    if (byCountry) {
      entry = byCountry;
    } else {
      note =
        `несколько локаций с именем «${input}» (${matches.map((m) => `${m.id} (${m.countryCode})`).join(', ')}): ` +
        `использован ${entry.id} (${entry.countryCode}) — уточните country или задайте criteria ID числом`;
    }
  }
  const resolved: ResolvedGeo = { loc: entry.id };
  const finalCountry = explicitCountry ?? COUNTRY_IDS[entry.countryCode];
  if (finalCountry !== undefined) resolved.country = finalCountry;
  if (note) resolved.note = note;
  return resolved;
}
