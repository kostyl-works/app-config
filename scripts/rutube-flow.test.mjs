// Порядок публикации описаний Rutube (publishDescriptions): токен сохраняется до записи описаний,
// актуальные описания не трогаются, токен без нужды не обменивается.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishDescriptions } from './rutube-flow.mjs';

/** Фейки с журналом вызовов. current — видео, в которых уже текущий конверт. */
function harness({ current = [], patchFails = false } = {}) {
  const calls = [];
  const deps = {
    videos: [
      { id: 'a'.repeat(32), token: 'ROMAN' },
      { id: 'b'.repeat(32), token: 'ROMAN' },
    ],
    tokens: { ROMAN: 'old' },
    verify: async (id) => {
      calls.push(`verify:${id[0]}`);
      return current.includes(id[0]);
    },
    refresh: async (label, token) => {
      calls.push(`refresh:${label}:${token}`);
      return { access: 'acc', refresh: 'new' };
    },
    writeBack: (tokens) => calls.push(`writeBack:${tokens.ROMAN}`),
    patch: async (id) => {
      calls.push(`patch:${id[0]}`);
      if (patchFails) throw new Error('patch failed');
      return true;
    },
    log: () => {},
    fail: (message) => {
      throw new Error(message);
    },
    secret: 'RUTUBE_TOKENS_PROD',
    manual: 'manual',
  };
  return { calls, deps };
}

test('новый токен записывается сразу после обмена, до записи описаний', async () => {
  const { calls, deps } = harness();
  const result = await publishDescriptions(deps);
  assert.deepEqual(calls, ['verify:a', 'verify:b', 'refresh:ROMAN:old', 'writeBack:new', 'patch:a', 'patch:b']);
  assert.deepEqual(result, { written: 2, current: 0 });
});

test('сбой записи описания не теряет новый токен', async () => {
  const { calls, deps } = harness({ patchFails: true });
  await assert.rejects(publishDescriptions(deps), /patch failed/);
  assert.ok(calls.indexOf('writeBack:new') < calls.indexOf('patch:a'), 'токен должен быть сохранён до записи описания');
});

test('актуальные описания пропускаются, токен не обменивается', async () => {
  const { calls, deps } = harness({ current: ['a', 'b'] });
  const result = await publishDescriptions(deps);
  assert.deepEqual(calls, ['verify:a', 'verify:b']);
  assert.deepEqual(result, { written: 0, current: 2 });
});

test('отставшее видео догоняется, актуальное не трогается', async () => {
  const { calls, deps } = harness({ current: ['a'] });
  const result = await publishDescriptions(deps);
  assert.deepEqual(calls, ['verify:a', 'verify:b', 'refresh:ROMAN:old', 'writeBack:new', 'patch:b']);
  assert.deepEqual(result, { written: 1, current: 1 });
});

test('нет метки в секрете — ошибка до обмена токена', async () => {
  const { calls, deps } = harness();
  deps.tokens = {};
  await assert.rejects(publishDescriptions(deps), /нет метки "ROMAN"/);
  assert.ok(!calls.some((c) => c.startsWith('refresh')));
});
