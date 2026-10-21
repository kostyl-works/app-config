#!/usr/bin/env node
// Проверяет с раннера GitHub, что у НОВЫХ хостов (которых нет в опубликованном конфиге)
// есть DNS и валидный TLS. Уже опубликованные не проверяем: аварийная смена api не должна
// падать из-за того, что сломался какой-то другой, давно опубликованный хост.
// Доступность из РФ так не проверить — только опечатки, мёртвые домены и битые сертификаты.
//   node scripts/check-hosts.mjs hosts.json [dist/config.json]
import { existsSync } from 'node:fs';
import { ROLES, readJson, validateHosts } from './lib.mjs';

const [hostsPath = 'hosts.json', publishedPath] = process.argv.slice(2);
let hosts;
try {
  hosts = validateHosts(readJson(hostsPath));
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}

const published = new Set();
if (publishedPath && existsSync(publishedPath)) {
  const config = readJson(publishedPath);
  for (const role of ROLES) for (const origin of config[role] ?? []) published.add(origin);
}

const fresh = [...new Set(ROLES.flatMap((role) => hosts[role]))].filter((origin) => !published.has(origin));
if (fresh.length === 0) {
  console.log('Новых хостов нет — проверять нечего.');
  process.exit(0);
}

let failed = 0;
for (const origin of fresh) {
  try {
    // Любой HTTP-ответ, даже 404 или 5xx, означает, что DNS и TLS в порядке.
    const response = await fetch(origin, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    console.log(`OK   ${origin} → HTTP ${response.status}`);
  } catch (error) {
    console.error(`::error::${origin}: ${error.cause?.code ?? error.cause?.message ?? error.message}`);
    failed++;
  }
}
if (failed) {
  console.error('Если хост ещё не поднят специально — запустите workflow вручную с skip_check.');
  process.exit(1);
}
