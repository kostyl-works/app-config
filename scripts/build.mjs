#!/usr/bin/env node
// Собирает следующий config.json из hosts.json: если хосты отличаются от опубликованных
// в config.json, ставит version = опубликованная + 1. Номер версии людьми не правится,
// чтобы его нельзя было забыть.
//
// Подписи пока нет. Когда понадобится, она ляжет рядом отдельным файлом config.json.sig,
// а формат config.json не изменится — уже выпущенные сборки приложения не сломаются.
//
//   node scripts/build.mjs --hosts hosts.json --out config.json
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { MAX_CONFIG_BYTES, ROLES, pickContent, readJson, validateSource } from './lib.mjs';

const { values: args } = parseArgs({
  options: {
    hosts: { type: 'string', default: 'hosts.json' },
    out: { type: 'string', default: 'config.json' },
  },
});

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

let desired;
try {
  desired = validateSource(readJson(args.hosts));
} catch (error) {
  fail(error.message);
}

const configPath = args.out;
const current = existsSync(configPath) ? readJson(configPath) : null;

if (current && JSON.stringify(pickContent(current)) === JSON.stringify(desired)) {
  console.log(`Конфиг совпадает с опубликованной version ${current.version} — публиковать нечего.`);
  output('changed', 'false');
  process.exit(0);
}

const config = { version: (current?.version ?? 0) + 1, ...desired };
const text = `${JSON.stringify(config)}\n`;
const bytes = Buffer.byteLength(text, 'utf8');
if (bytes > MAX_CONFIG_BYTES) fail(`конфиг ${bytes} байт > ${MAX_CONFIG_BYTES}: слишком много хостов`);

writeFileSync(configPath, text);
output('changed', 'true');
output('version', config.version);

console.log(`version ${current?.version ?? '—'} → ${config.version}, ${bytes} байт`);
const enabledMark = current?.enabled === config.enabled ? '  ' : '* ';
console.log(`${enabledMark}${'enabled'.padEnd(10)} ${config.enabled}`);
for (const role of ROLES) {
  const before = (current?.[role] ?? []).join(', ');
  const after = desired[role].join(', ');
  console.log(`${before === after ? '  ' : '* '}${role.padEnd(10)} ${after}`);
}
