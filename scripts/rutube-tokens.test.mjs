// Выбор секрета refresh-токенов Rutube по окружению (rutubeTokenSource).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rutubeTokenSource } from './lib.mjs';

test('prod читает и пишет только RUTUBE_TOKENS_PROD', () => {
  const env = { RUTUBE_TOKENS_PROD: '{"ROMAN":"p"}', RUTUBE_TOKENS_DEV: '{"dev":"d"}', RUTUBE_TOKENS_LEGACY: '{"dev":"l"}' };
  assert.deepEqual(rutubeTokenSource('prod', env), { secret: 'RUTUBE_TOKENS_PROD', raw: '{"ROMAN":"p"}' });
});

test('prod без своего секрета не берёт чужие токены', () => {
  const env = { RUTUBE_TOKENS_DEV: '{"dev":"d"}', RUTUBE_TOKENS_LEGACY: '{"dev":"l"}' };
  assert.deepEqual(rutubeTokenSource('prod', env), { secret: 'RUTUBE_TOKENS_PROD', raw: '' });
});

test('dev берёт RUTUBE_TOKENS_DEV, если он есть', () => {
  const env = { RUTUBE_TOKENS_DEV: '{"dev":"d"}', RUTUBE_TOKENS_LEGACY: '{"dev":"l"}' };
  assert.deepEqual(rutubeTokenSource('dev', env), { secret: 'RUTUBE_TOKENS_DEV', raw: '{"dev":"d"}' });
});

test('dev до переезда читает старый общий секрет, а пишет уже в RUTUBE_TOKENS_DEV', () => {
  const env = { RUTUBE_TOKENS_DEV: '', RUTUBE_TOKENS_LEGACY: '{"dev":"l"}' };
  assert.deepEqual(rutubeTokenSource('dev', env), { secret: 'RUTUBE_TOKENS_DEV', raw: '{"dev":"l"}' });
});

test('неизвестное окружение — ошибка', () => {
  assert.throws(() => rutubeTokenSource(undefined, {}), /неизвестное окружение/);
  assert.throws(() => rutubeTokenSource('stage', {}), /неизвестное окружение/);
});
