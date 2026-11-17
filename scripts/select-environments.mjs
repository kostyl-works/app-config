#!/usr/bin/env node
// SAM-809: публикация только вручную — окружение берём из input ручного запуска. Автопубликации
// при пуше нет: правка hosts.json сама в прод не уходит.
import { appendFileSync } from 'node:fs';
import { readJson } from './lib.mjs';

try {
  const event = readJson(process.env.GITHUB_EVENT_PATH);
  if (process.env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Публикация разрешена только из main. Выберите main в Run workflow.');
  }
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    throw new Error(
      `Автопубликации нет (событие ${process.env.GITHUB_EVENT_NAME}): публикуй пунктом «Публикация конфига» ` +
        'в crypto/keys-dev.sh / crypto/keys-prod.sh или кнопкой Run workflow.',
    );
  }
  const environment = event.inputs?.environment;
  if (!['prod', 'dev'].includes(environment)) {
    throw new Error('Выберите окружение prod или dev.');
  }

  const value = JSON.stringify([environment]);
  appendFileSync(process.env.GITHUB_OUTPUT, `environments=${value}\n`);
  console.log(`Окружения для публикации: ${value}`);
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}
