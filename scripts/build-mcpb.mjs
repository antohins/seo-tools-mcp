#!/usr/bin/env node
/**
 * Сборка MCPB-бандлов (.mcpb) — установка сервера в Claude Desktop В ОДИН КЛИК,
 * без npx и ручной правки JSON-конфига.
 *
 * Как устроено: собираем ОДИН самодостаточный файл (все зависимости внутрь), рядом
 * кладём manifest.json и иконку, и пакуем CLI `@anthropic-ai/mcpb`. Однофайловая
 * сборка даёт ~1.5 МБ вместо ~23 МБ у варианта с node_modules (`pnpm deploy --prod`).
 *
 * ВАЖНО про banner: часть зависимостей — CJS с динамическим require (у
 * google-auth-library это require('child_process')). В ESM-бандле такой вызов падает,
 * поэтому подмешиваем createRequire — без него gsc/ga4 не стартуют вовсе.
 *
 * user_config заполняем ТОЛЬКО обязательными ключами (API-ключи). У OAuth-серверов
 * (gsc/ga4/ywm/metrika) полей нет вовсе: там авторизация проходит прямо в чате
 * (<server>_oauth_start → _oauth_finish), и подставлять пустые значения в env вредно.
 *
 * Запуск: node scripts/build-mcpb.mjs [сервер…]   (без аргументов — все)
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-mcpb');
const STAGE = join(ROOT, '.mcpb-stage');

const ALL = ['xmlstock', 'xmlriver', 'wordstat', 'gsc', 'ga4', 'ywm', 'metrika', 'aparser'];

/**
 * Обязательные креды по серверам → в user_config. Ключ — имя env-переменной.
 * Что не перечислено (дефолтные свойства, пресеты, OAuth-токены) задаётся в чате
 * через <server>_set_credentials, поэтому в манифест не тянем.
 */
const REQUIRED_CONFIG = {
  xmlstock: ['XMLSTOCK_USER', 'XMLSTOCK_KEY'],
  xmlriver: ['XMLRIVER_USER', 'XMLRIVER_KEY'],
  wordstat: ['WORDSTAT_API_KEY', 'WORDSTAT_FOLDER_ID'],
  aparser: ['APARSER_URL', 'APARSER_PASSWORD'],
  gsc: [],
  ga4: [],
  ywm: [],
  metrika: [],
};

/** Человекочитаемый заголовок поля из env-имени: XMLSTOCK_KEY → «XMLStock key». */
const titleFor = (env) => {
  const [head, ...rest] = env.split('_');
  const brand = { XMLSTOCK: 'XMLStock', XMLRIVER: 'XMLRiver', WORDSTAT: 'Wordstat', APARSER: 'A-Parser' }[head] ?? head;
  return [brand, ...rest.map((w) => w.toLowerCase())].join(' ');
};

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe', ...opts });

/** ESM-бандл не умеет динамический require из CJS-зависимостей — возвращаем его. */
const REQUIRE_BANNER = { js: "import{createRequire as __mcpbRequire}from'module';const require=__mcpbRequire(import.meta.url);" };

/**
 * Смоук собранного бандла: поднимаем его по stdio и просим список инструментов.
 * Именно spawn, а не execFileSync с input: тот закрывает stdin сразу, сервер успевает
 * завершиться до обработки tools/list, и проверка ложно падает.
 */
function smokeToolCount(entry) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [entry], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const done = (fn, arg) => {
      clearTimeout(timer);
      proc.kill();
      fn(arg);
    };
    const timer = setTimeout(() => done(reject, new Error(`смоук ${entry}: нет ответа за 30 с`)), 30_000);
    proc.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        try {
          const msg = JSON.parse(line);
          if (msg?.id === 2) return done(resolve, msg.result?.tools?.length ?? 0);
        } catch {
          /* строка ещё не дочитана — ждём следующий чанк */
        }
      }
    });
    proc.on('error', (e) => done(reject, e));
    proc.stdin.write(
      `${[
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pack-check', version: '0' } } }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      ].join('\n')}\n`,
    );
  });
}

async function buildOne(name) {
  const pkgName = `seo-tools-mcp-${name}`;
  const pkg = JSON.parse(readFileSync(join(ROOT, 'servers', name, 'package.json'), 'utf8'));
  const serverJson = JSON.parse(readFileSync(join(ROOT, 'servers', name, 'server.json'), 'utf8'));
  const envMeta = Object.fromEntries((serverJson.packages?.[0]?.environmentVariables ?? []).map((e) => [e.name, e]));

  const stage = join(STAGE, name);
  rmSync(stage, { recursive: true, force: true });
  // всё внутрь одного файла: бандл не тащит node_modules и не зависит от установки пакетов
  await build({
    entry: [`servers/${name}/src/index.ts`],
    outDir: join(stage, 'dist'),
    format: ['esm'],
    target: 'node20',
    noExternal: [/.*/],
    banner: REQUIRE_BANNER,
    clean: true,
    silent: true,
  });

  const required = REQUIRED_CONFIG[name] ?? [];
  const userConfig = {};
  const env = {};
  for (const envName of required) {
    const key = envName.toLowerCase();
    const meta = envMeta[envName];
    userConfig[key] = {
      type: 'string',
      title: titleFor(envName),
      description: meta?.description ?? envName,
      required: true,
      sensitive: Boolean(meta?.isSecret),
    };
    env[envName] = `\${user_config.${key}}`;
  }

  const manifest = {
    manifest_version: '0.3',
    name: pkgName,
    display_name: serverJson.title ?? pkgName,
    version: pkg.version,
    description: serverJson.description,
    long_description:
      `${serverJson.description}\n\n` +
      'Часть набора seo-tools-mcp — восемь read-only MCP-серверов для SEO на рынке Google/Яндекса. ' +
      (required.length
        ? 'Ключи задаются при установке (ниже) либо прямо в чате: <server>_auth_status → <server>_set_credentials.'
        : 'Авторизация проходит прямо в чате: <server>_auth_status → <server>_oauth_start → <server>_oauth_finish; ключи никуда вводить заранее не нужно.'),
    author: { name: 'antohins', url: 'https://github.com/antohins' },
    repository: { type: 'git', url: 'https://github.com/antohins/seo-tools-mcp' },
    homepage: 'https://github.com/antohins/seo-tools-mcp#readme',
    documentation: `https://github.com/antohins/seo-tools-mcp/tree/main/servers/${name}#readme`,
    support: 'https://github.com/antohins/seo-tools-mcp/issues',
    icon: 'icon.png',
    license: 'MIT',
    keywords: pkg.keywords ?? [],
    server: {
      type: 'node',
      entry_point: 'dist/index.js',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/dist/index.js'],
        ...(Object.keys(env).length ? { env } : {}),
      },
    },
    ...(Object.keys(userConfig).length ? { user_config: userConfig } : {}),
    compatibility: { runtimes: { node: '>=20' } },
  };

  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(join(ROOT, 'assets', 'logo-128.png'), join(stage, 'icon.png'));

  mkdirSync(OUT, { recursive: true });
  const out = join(OUT, `${pkgName}.mcpb`);
  run('npx', ['-y', '@anthropic-ai/mcpb@2', 'pack', stage, out]);
  const listed = await smokeToolCount(join(stage, 'dist', 'index.js'));
  if (!listed) throw new Error(`${pkgName}: бандл собран, но не отдал список инструментов — проверь сборку`);
  const size = (readFileSync(out).length / 1024 / 1024).toFixed(1);
  console.log(`  ✓ ${pkgName}.mcpb — ${size} MB, инструментов ${listed}${required.length ? `, ключей в установщике ${required.length}` : ', OAuth в чате'}`);
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
for (const t of targets) {
  if (!ALL.includes(t)) throw new Error(`Неизвестный сервер: ${t}. Доступны: ${ALL.join(', ')}`);
}
if (!existsSync(join(ROOT, 'assets', 'logo-128.png'))) throw new Error('Нет assets/logo-128.png — иконка обязательна для бандла');

console.log(`Сборка MCPB-бандлов (${targets.length}):`);
for (const t of targets) await buildOne(t);
rmSync(STAGE, { recursive: true, force: true });
console.log(`\nГотово: ${OUT}`);
