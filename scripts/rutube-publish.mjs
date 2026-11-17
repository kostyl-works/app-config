#!/usr/bin/env node
// SAM-809: публикует подписанный конверт в описания видео Rutube. Для каждого видео из
// rutube.json шифрует конверт ключом с солью = videoId и кладёт его между метками в описание.
//
// Токен доступа Rutube живёт недолго — получаем свежий по refresh-токену (он ОДНОРАЗОВЫЙ:
// Rutube отдаёт новый, старый гаснет). Новый refresh-токен ОБЯЗАТЕЛЬНО сохраняем обратно в
// секрет своего окружения (RUTUBE_TOKENS_PROD / RUTUBE_TOKENS_DEV), иначе следующий прогон
// упадёт. Запись секрета делает отдельный PAT.
//
//   ENVIRONMENT=dev CIPHER_KEY=<base64url> RUTUBE_TOKENS_DEV='{"dev":"<refresh>"}' GH_PAT=<pat> \
//   GITHUB_REPOSITORY=kostyl-works/app-config \
//     node scripts/rutube-publish.mjs --config dev/config.json --rutube dev/rutube.json
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { RUTUBE_BEGIN, RUTUBE_END, rutubeDescription, streamCipher, unwrapAny } from './crypto.mjs';
import { readJson, rutubeTokenSource } from './lib.mjs';
import { DESCRIPTION, publishDescriptions } from './rutube-flow.mjs';

const MANUAL = 'docs/features/dynamic-base-url/rutube/05_refresh_token_manual.md (в репозитории приложения)';
const TOKEN_ENDPOINT = 'https://rutube.ru/multipass/api/v3/accounts/token/';

const { values: args } = parseArgs({
  options: {
    config: { type: 'string', default: 'config.json' },
    rutube: { type: 'string', default: 'rutube.json' },
  },
});

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const cipherKeyB64 = process.env.CIPHER_KEY;
if (!cipherKeyB64) fail('нет CIPHER_KEY (секрет CIPHER_KEY_PROD / CIPHER_KEY_DEV).');
const cipherKey = Buffer.from(cipherKeyB64, 'base64url');

let source;
try {
  source = rutubeTokenSource(process.env.ENVIRONMENT, process.env);
} catch (error) {
  fail(`${error.message}. Переменная ENVIRONMENT приходит из matrix в publish.yml.`);
}
const SECRET = source.secret;
if (!source.raw) {
  fail(
    `секрет ${SECRET} не задан или пуст. Положи в него JSON вида {"<метка>":"<refresh-токен>"} — ` +
      `метка та же, что "token" у видео в rutube.json. Токен получают по мануалу: ${MANUAL}`,
  );
}

let tokens;
try {
  tokens = JSON.parse(source.raw);
  if (!tokens || typeof tokens !== 'object') throw new Error('ожидается объект {"метка":"<refresh-токен>"}');
} catch (error) {
  fail(
    `секрет ${SECRET} не разбирается (${error.message}). Это JSON вида {"<метка>":"<refresh-токен>"}. ` +
      `Свежий токен получают по мануалу: ${MANUAL}`,
  );
}

const videos = (readJson(args.rutube).videos ?? []).filter((v) => v.id && v.token);
if (videos.length === 0) {
  console.log(`${args.rutube}: видео нет — публиковать в Rutube нечего.`);
  process.exit(0);
}

// Конверт целиком (строка {p,s}) — его и шифруем в описание.
const envelope = readFileSync(args.config, 'utf8').trim();

/** Обновляет access-токен по refresh-токену. Возвращает {access, refresh(новый)}. */
async function refresh(label, refreshToken) {
  let response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `refreshToken=${refreshToken}` },
      body: '{}',
    });
  } catch (error) {
    fail(`Rutube refresh (метка "${label}"): сеть недоступна (${error.message}).`);
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (response.status !== 200 && response.status !== 201) {
    fail(
      `Rutube refresh (метка "${label}") вернул HTTP ${response.status}. Скорее всего refresh-токен ` +
        `протух или уже использован. Что делать: получи свежий токен по мануалу (${MANUAL}) и обнови ` +
        `секрет ${SECRET}: положи в него {"${label}":"<новый refresh-токен>"}. Ответ: ${text.slice(0, 200)}`,
    );
  }
  if (!body?.access_token || !body?.refresh_token) {
    fail(`Rutube refresh (метка "${label}"): в ответе нет access_token/refresh_token. Ответ: ${text.slice(0, 200)}`);
  }
  return { access: body.access_token, refresh: body.refresh_token };
}

/** PATCH описания видео. Сбой — fail. Подтверждение чтением — в rutube-flow.mjs (с повторами). */
async function patch(videoId, access) {
  const description = rutubeDescription(envelope, cipherKey, videoId);
  let response;
  try {
    response = await fetch(`https://rutube.ru/api/video/${videoId}/`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${access}` },
      body: JSON.stringify({ description }),
    });
  } catch (error) {
    fail(`Rutube PATCH видео ${videoId}: сеть недоступна (${error.message}).`);
  }
  const text = await response.text();
  if (response.status !== 200) {
    fail(
      `Rutube PATCH видео ${videoId} вернул HTTP ${response.status}. Проверь, что видео принадлежит ` +
        `аккаунту метки и id верный (32 hex). Ответ: ${text.slice(0, 200)}`,
    );
  }
}

/**
 * Анонимно (как приложение) читает описание видео и возвращает его состояние (DESCRIPTION в
 * rutube-flow.mjs): current — текущий конверт; stale — другой, прежний конверт; missing — меток нет;
 * broken — между метками не конверт (искажено или зашифровано другим ключом); unreadable — не прочиталось.
 */
async function verify(videoId) {
  let desc;
  try {
    const r = await fetch(`https://rutube.ru/api/video/${videoId}/`, { headers: { accept: 'application/json' } });
    if (!r.ok) return DESCRIPTION.unreadable;
    desc = (await r.json()).description ?? '';
  } catch {
    return DESCRIPTION.unreadable;
  }
  const i = desc.indexOf(RUTUBE_BEGIN);
  const j = desc.indexOf(RUTUBE_END, i + RUTUBE_BEGIN.length);
  if (i < 0 || j < 0) return DESCRIPTION.missing;
  const cipher = Buffer.from(desc.slice(i + RUTUBE_BEGIN.length, j).replace(/\s/g, ''), 'base64url');
  const plain = streamCipher(cipherKey, Buffer.from(videoId, 'utf8'), cipher).toString('utf8');
  if (plain === envelope) return DESCRIPTION.current;
  return unwrapAny(plain) ? DESCRIPTION.stale : DESCRIPTION.broken;
}

/** Пишет обновлённый секрет RUTUBE_TOKENS через PAT. */
function writeBackSecret(updated) {
  const pat = process.env.GH_PAT;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!pat) {
    console.error(
      `::warning::refresh-токен(ы) проротировались, но GH_PAT не задан — новый токен НЕ сохранён в ` +
        `секрет ${SECRET}. СЛЕДУЮЩИЙ ПРОГОН УПАДЁТ. Почини так: создай PAT с правом secrets:write на ` +
        `${repo}, положи его в секрет GH_PAT. Пока PAT нет — перед каждым прогоном обновляй ${SECRET} ` +
        `вручную (мануал: ${MANUAL}).`,
    );
    return;
  }
  const result = spawnSync('gh', ['secret', 'set', SECRET, '-R', repo], {
    input: JSON.stringify(updated),
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: pat },
  });
  if (result.status !== 0) {
    fail(
      `не удалось записать секрет ${SECRET} через PAT (${(result.stderr || result.stdout || '').trim()}). ` +
        `Обмен уже прошёл — старый refresh-токен сгорел, новый не сохранён. Что делать: проверь, что ` +
        `GH_PAT жив и имеет право secrets:write на ${repo}, потом возьми свежий токен по мануалу ` +
        `(${MANUAL}) и положи его в ${SECRET}.`,
    );
  }
  console.log(`Секрет ${SECRET} обновлён новыми refresh-токенами.`);
}

// --- прогон ---
// Порядок (сверка → обмен → СРАЗУ запись токена → описания) — в rutube-flow.mjs, под тестом.
const { written, current, unconfirmed } = await publishDescriptions({
  videos,
  tokens,
  verify,
  refresh,
  writeBack: writeBackSecret,
  patch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
  warn: (message) => console.log(`::warning::${message}`),
  fail,
  secret: SECRET,
  manual: MANUAL,
});
console.log(
  `Готово: записано описаний — ${written} (из них ещё не доехало до анонимного чтения — ${unconfirmed}), ` +
    `уже актуальных — ${current}.`,
);
