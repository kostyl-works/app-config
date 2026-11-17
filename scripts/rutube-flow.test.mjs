// Порядок публикации описаний Rutube (publishDescriptions): токен сохраняется до записи описаний,
// актуальные описания не трогаются, токен без нужды не обменивается, запись подтверждается
// чтением с повторами (Rutube отдаёт новое описание не сразу).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishDescriptions } from './rutube-flow.mjs';

/**
 * Фейки с журналом вызовов. current — видео, в которых уже текущий конверт. staleReads — сколько
 * чтений после записи Rutube ещё отдаёт старое описание (Infinity — не отдаст новое никогда).
 */
function harness({ current = [], patchFails = false, staleReads = 0 } = {}) {
  const calls = [];
  const written = new Map(); // видео → сколько старых чтений осталось
  const sleeps = [];
  const deps = {
    videos: [
      { id: 'a'.repeat(32), token: 'ROMAN' },
      { id: 'b'.repeat(32), token: 'ROMAN' },
    ],
    tokens: { ROMAN: 'old' },
    verify: async (id) => {
      calls.push(`verify:${id[0]}`);
      if (written.has(id[0])) {
        const left = written.get(id[0]);
        written.set(id[0], left - 1);
        return left <= 0;
      }
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
      written.set(id[0], staleReads);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    confirm: { attempts: 6, delayMs: 5000 },
    log: () => {},
    fail: (message) => {
      throw new Error(message);
    },
    secret: 'RUTUBE_TOKENS_PROD',
    manual: 'manual',
  };
  return { calls, sleeps, deps };
}

test('новый токен записывается сразу после обмена, до записи описаний', async () => {
  const { calls, deps } = harness();
  const result = await publishDescriptions(deps);
  assert.deepEqual(calls, [
    'verify:a', 'verify:b', 'refresh:ROMAN:old', 'writeBack:new',
    'patch:a', 'verify:a', 'patch:b', 'verify:b',
  ]);
  assert.deepEqual(result, { written: 2, current: 0 });
});

test('сбой записи описания не теряет новый токен', async () => {
  const { calls, deps } = harness({ patchFails: true });
  await assert.rejects(publishDescriptions(deps), /patch failed/);
  assert.ok(calls.indexOf('writeBack:new') < calls.indexOf('patch:a'), 'токен должен быть сохранён до записи описания');
});

test('актуальные описания пропускаются, токен не обменивается', async () => {
  const { calls, sleeps, deps } = harness({ current: ['a', 'b'] });
  const result = await publishDescriptions(deps);
  assert.deepEqual(calls, ['verify:a', 'verify:b']);
  assert.deepEqual(sleeps, [], 'без записи — без ожидания');
  assert.deepEqual(result, { written: 0, current: 2 });
});

test('отставшее видео догоняется, актуальное не трогается', async () => {
  const { calls, deps } = harness({ current: ['a'] });
  const result = await publishDescriptions(deps);
  assert.deepEqual(calls, ['verify:a', 'verify:b', 'refresh:ROMAN:old', 'writeBack:new', 'patch:b', 'verify:b']);
  assert.deepEqual(result, { written: 1, current: 1 });
});

test('Rutube отдаёт старое описание два чтения — запись подтверждается с третьей попытки', async () => {
  const { calls, sleeps, deps } = harness({ current: ['a'], staleReads: 2 });
  const result = await publishDescriptions(deps);
  assert.deepEqual(calls.slice(-4), ['patch:b', 'verify:b', 'verify:b', 'verify:b']);
  assert.deepEqual(sleeps, [5000, 5000, 5000], 'пауза перед каждым перечитыванием');
  assert.deepEqual(result, { written: 1, current: 1 });
});

test('описание так и не подтвердилось — ошибка после всех попыток, токен уже сохранён', async () => {
  const { calls, sleeps, deps } = harness({ current: ['a'], staleReads: Infinity });
  await assert.rejects(publishDescriptions(deps), /за 30 с конверт из него так и не прочитался/);
  assert.equal(calls.filter((c) => c === 'verify:b').length, 1 + 6, 'сверка до записи + 6 попыток');
  assert.equal(sleeps.length, 6);
  assert.ok(calls.includes('writeBack:new'));
});

test('нет метки в секрете — ошибка до обмена токена', async () => {
  const { calls, deps } = harness();
  deps.tokens = {};
  await assert.rejects(publishDescriptions(deps), /нет метки "ROMAN"/);
  assert.ok(!calls.some((c) => c.startsWith('refresh')));
});
