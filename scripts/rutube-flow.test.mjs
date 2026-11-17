// Порядок публикации описаний Rutube (publishDescriptions): токен сохраняется до записи описаний,
// актуальные описания не трогаются, токен без нужды не обменивается, запись подтверждается
// чтением с ожиданием (Rutube отдаёт новое описание не сразу), решение — по последнему состоянию.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DESCRIPTION, publishDescriptions } from './rutube-flow.mjs';

/**
 * Фейки с журналом вызовов.
 * current — видео, в которых уже текущий конверт; before — состояние остальных до записи;
 * after — что отдаёт чтение после записи, по очереди; кончилось — current (или last, если never).
 */
function harness({ current = [], before = DESCRIPTION.stale, after = [], never = false, patchFails = false } = {}) {
  const calls = [];
  const sleeps = [];
  const warnings = [];
  const pending = new Map(); // видео → очередь состояний после записи
  const deps = {
    videos: [
      { id: 'a'.repeat(32), token: 'ROMAN' },
      { id: 'b'.repeat(32), token: 'ROMAN' },
    ],
    tokens: { ROMAN: 'old' },
    verify: async (id) => {
      calls.push(`verify:${id[0]}`);
      const queue = pending.get(id[0]);
      if (!queue) return current.includes(id[0]) ? DESCRIPTION.current : before;
      if (queue.length > 1 || (queue.length === 1 && !never)) return queue.shift();
      return queue.length === 1 ? queue[0] : DESCRIPTION.current;
    },
    refresh: async (label, token) => {
      calls.push(`refresh:${label}:${token}`);
      return { access: 'acc', refresh: 'new' };
    },
    writeBack: (tokens) => calls.push(`writeBack:${tokens.ROMAN}`),
    patch: async (id) => {
      calls.push(`patch:${id[0]}`);
      if (patchFails) throw new Error('patch failed');
      pending.set(id[0], [...after]);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    confirm: { attempts: 6, delayMs: 5000 },
    log: () => {},
    warn: (message) => warnings.push(message),
    fail: (message) => {
      throw new Error(message);
    },
    secret: 'RUTUBE_TOKENS_PROD',
    manual: 'manual',
  };
  return { calls, sleeps, warnings, deps };
}

test('новый токен записывается сразу после обмена, до записи описаний', async () => {
  const { calls, deps } = harness();
  const result = await publishDescriptions(deps);
  assert.deepEqual(calls, [
    'verify:a', 'verify:b', 'refresh:ROMAN:old', 'writeBack:new',
    'patch:a', 'verify:a', 'patch:b', 'verify:b',
  ]);
  assert.deepEqual(result, { written: 2, current: 0, unconfirmed: 0 });
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
  assert.deepEqual(result, { written: 0, current: 2, unconfirmed: 0 });
});

test('отставшее видео догоняется, актуальное не трогается', async () => {
  const { calls, deps } = harness({ current: ['a'] });
  const result = await publishDescriptions(deps);
  assert.deepEqual(calls, ['verify:a', 'verify:b', 'refresh:ROMAN:old', 'writeBack:new', 'patch:b', 'verify:b']);
  assert.deepEqual(result, { written: 1, current: 1, unconfirmed: 0 });
});

test('описание без конверта при сверке — тоже повод писать', async () => {
  const { calls, deps } = harness({ current: ['a'], before: DESCRIPTION.missing });
  const result = await publishDescriptions(deps);
  assert.ok(calls.includes('patch:b'));
  assert.deepEqual(result, { written: 1, current: 1, unconfirmed: 0 });
});

test('Rutube отдаёт прежний конверт два чтения — подтверждается с третьей попытки', async () => {
  const { calls, sleeps, warnings, deps } = harness({ current: ['a'], after: [DESCRIPTION.stale, DESCRIPTION.stale] });
  const result = await publishDescriptions(deps);
  assert.deepEqual(calls.slice(-4), ['patch:b', 'verify:b', 'verify:b', 'verify:b']);
  assert.deepEqual(sleeps, [5000, 5000, 5000], 'пауза перед каждым перечитыванием');
  assert.deepEqual(warnings, []);
  assert.deepEqual(result, { written: 1, current: 1, unconfirmed: 0 });
});

test('прежний конверт до конца ожидания — предупреждение, не ошибка (задержка Rutube)', async () => {
  const { calls, sleeps, warnings, deps } = harness({ current: ['a'], after: [DESCRIPTION.stale], never: true });
  const result = await publishDescriptions(deps);
  assert.equal(calls.filter((c) => c === 'verify:b').length, 1 + 6, 'сверка до записи + 6 попыток');
  assert.equal(sleeps.length, 6);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /так и отдаёт прежний конверт/);
  assert.deepEqual(result, { written: 1, current: 1, unconfirmed: 1 });
});

test('описание без конверта или ошибка чтения до конца — тоже предупреждение', async () => {
  for (const status of [DESCRIPTION.missing, DESCRIPTION.unreadable]) {
    const { warnings, deps } = harness({ current: ['a'], after: [status], never: true });
    const result = await publishDescriptions(deps);
    assert.equal(warnings.length, 1, status);
    assert.equal(result.unconfirmed, 1, status);
  }
});

test('между метками не конверт до конца ожидания — ошибка «Rutube исказил», токен уже сохранён', async () => {
  const { calls, deps } = harness({ current: ['a'], after: [DESCRIPTION.broken], never: true });
  await assert.rejects(publishDescriptions(deps), /Rutube исказил описание/);
  assert.ok(calls.includes('writeBack:new'));
});

test('выпуск ключей с нуля: сначала старое на прежнем ключе шифрования (broken), потом текущее — OK', async () => {
  const { warnings, deps } = harness({ current: ['a'], after: [DESCRIPTION.broken, DESCRIPTION.broken] });
  const result = await publishDescriptions(deps);
  assert.deepEqual(warnings, []);
  assert.deepEqual(result, { written: 1, current: 1, unconfirmed: 0 });
});

test('нет метки в секрете — ошибка до обмена токена', async () => {
  const { calls, deps } = harness();
  deps.tokens = {};
  await assert.rejects(publishDescriptions(deps), /нет метки "ROMAN"/);
  assert.ok(!calls.some((c) => c.startsWith('refresh')));
});
