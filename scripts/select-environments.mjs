#!/usr/bin/env node
// На push выбираем окружения по diff всего push, на ручной запуск — по input.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readJson } from './lib.mjs';

try {
  const event = readJson(process.env.GITHUB_EVENT_PATH);
  if (process.env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Публикация разрешена только из main. Выберите main в Run workflow.');
  }

  let environments;
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    const environment = event.inputs?.environment;
    if (!['prod', 'dev'].includes(environment)) {
      throw new Error('Выберите окружение prod или dev.');
    }
    environments = [environment];
  } else if (process.env.GITHUB_EVENT_NAME === 'push') {
    const { before, after } = event;
    if (![before, after].every((sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha))) {
      throw new Error('В push отсутствуют корректные before/after SHA.');
    }
    const args = /^0+$/.test(before)
      ? ['ls-tree', '-r', '--name-only', after]
      : ['diff', '--name-only', '--no-renames', before, after, '--'];
    const paths = new Set(execFileSync('git', args, { encoding: 'utf8' }).trim().split('\n'));
    // Окружение публикуем, если изменились его хосты или список видео Rutube (etag зависит от него).
    environments = [
      ...(paths.has('hosts.json') || paths.has('rutube.json') ? ['prod'] : []),
      ...(paths.has('dev/hosts.json') || paths.has('dev/rutube.json') ? ['dev'] : []),
    ];
  } else {
    throw new Error(`Неподдерживаемое событие: ${process.env.GITHUB_EVENT_NAME}`);
  }

  const value = JSON.stringify(environments);
  appendFileSync(process.env.GITHUB_OUTPUT, `environments=${value}\n`);
  console.log(`Окружения для публикации: ${value}`);
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}
