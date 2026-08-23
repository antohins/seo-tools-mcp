#!/usr/bin/env node
/**
 * Единый источник правды о версии — корневой package.json.
 *
 * Версия дублируется в трёх десятках мест, и рассинхрон уже приводил к реальному инциденту:
 * релиз 1.5.0 обновил package.json, но не server.json — в итоге официальный реестр MCP
 * так и не получил выпущенную версию, а npm её получил. Этот скрипт делает расхождение
 * невозможным: `--check` (по умолчанию) падает в CI, `--write` расставляет версию везде.
 *
 *   node scripts/sync-version.mjs           # проверить (exit 1 при расхождении)
 *   node scripts/sync-version.mjs --write   # синхронизировать
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

/**
 * Серверы читаем С ДИСКА, а не из захардкоженного списка: иначе девятый сервер
 * молча выпадет из синхронизации — ровно тот класс ошибки, ради которого скрипт и написан.
 */
const SERVERS_DIR = join(ROOT, 'servers');
const SERVERS = readdirSync(SERVERS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(SERVERS_DIR, e.name, 'package.json')))
  .map((e) => e.name)
  .sort();

const problems = [];
const fixed = [];
let places = 0;

const rel = (p) => relative(ROOT, p);

/**
 * Проверяет (или чинит) одно поле JSON.
 * `set` вызывается только когда `get` вернул значение, поэтому сеттеру не нужны guard'ы
 * на отсутствующие узлы: нет поля — это отдельная понятная жалоба, а не TypeError
 * посреди прохода с уже переписанной половиной файлов.
 */
function checkField(path, get, set, label) {
  places++;
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const actual = get(json);
  const where = `${rel(path)} → ${label}`;
  if (actual === VERSION) return;
  if (actual === undefined) {
    problems.push(`${where}: поле отсутствует`);
    return;
  }
  if (!WRITE) {
    problems.push(`${where}: ${actual} (ожидалось ${VERSION})`);
    return;
  }
  set(json);
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  fixed.push(`${where}: ${actual} → ${VERSION}`);
}

for (const name of SERVERS) {
  const pkg = join(SERVERS_DIR, name, 'package.json');
  checkField(pkg, (j) => j.version, (j) => { j.version = VERSION; }, 'version');

  const srv = join(SERVERS_DIR, name, 'server.json');
  if (existsSync(srv)) {
    checkField(srv, (j) => j.version, (j) => { j.version = VERSION; }, 'version');
    checkField(srv, (j) => j.packages?.[0]?.version, (j) => { j.packages[0].version = VERSION; }, 'packages[0].version');
  } else {
    problems.push(`${rel(srv)}: файл отсутствует (нужен для публикации в реестр MCP)`);
  }

  // Литерал в new McpServer({ name, version: 'X.Y.Z' }) — его не покрывает ни один JSON-патчер
  const idx = join(SERVERS_DIR, name, 'src', 'index.ts');
  places++;
  const src = readFileSync(idx, 'utf8');
  const m = /new McpServer\(\{[^}]*version:\s*'([^']+)'/s.exec(src);
  if (!m) {
    problems.push(`${rel(idx)}: не найден литерал версии в new McpServer(...)`);
  } else if (m[1] !== VERSION) {
    if (WRITE) {
      writeFileSync(idx, src.replace(m[0], m[0].replace(`'${m[1]}'`, `'${VERSION}'`)));
      fixed.push(`${rel(idx)} → McpServer: ${m[1]} → ${VERSION}`);
    } else {
      problems.push(`${rel(idx)} → McpServer: ${m[1]} (ожидалось ${VERSION})`);
    }
  }
}

const plugin = join(ROOT, '.plugin', 'plugin.json');
checkField(plugin, (j) => j.version, (j) => { j.version = VERSION; }, 'version');

if (fixed.length) console.log(`Синхронизировано под ${VERSION}:\n  ${fixed.join('\n  ')}`);

// problems пополняется и в режиме --write (отсутствующее поле/файл автоматом не чинится),
// поэтому выходим с ошибкой в ОБОИХ режимах — иначе «синхронизировано» врало бы.
if (problems.length) {
  console.error(`${fixed.length ? '\n' : ''}Требует вмешательства (версия в корне — ${VERSION}):\n  ${problems.join('\n  ')}`);
  if (!WRITE) console.error('\nПочинить автоматически: pnpm version:sync');
  process.exit(1);
}

if (!fixed.length) console.log(`Версии синхронны: ${VERSION} (серверов: ${SERVERS.length}, мест: ${places}).`);
