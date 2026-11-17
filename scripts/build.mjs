#!/usr/bin/env node
// Собирает следующий config.json из hosts.json. Если хосты (или список видео etag) отличаются
// от опубликованного, ставит version = опубликованная + 1. Номер версии людьми не правится.
//
// SAM-809: config.json — ПОДПИСАННЫЙ КОНВЕРТ {"p": base64url(bytes конфига), "s": base64url(
// подпись Ed25519)}. Приложение проверяет подпись ДО разбора и отвергает неподписанное
// (fail-closed). Внутри конфига поле etag — зашифрованный список videoId (для Rutube).
//
// Источник правды об опубликованном — ПОСЛЕДНИЙ ТЕГ окружения (теги ставит только CI, правило
// репозитория), а не config.json в ветке. Ключ подписи — только из белого списка keys.json
// (ключи, которые знает выпущенная сборка). Опубликованный конверт подписан другим ключом
// (после ротации) — переподписываем с version + 1.
//
//   SIGN_KEY=<base64url seed> CIPHER_KEY=<base64url> \
//     node scripts/build.mjs --hosts hosts.json --out config.json --rutube rutube.json [--keys keys.json]
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ETAG_SALT, encodeVideoList, fromB64url, publicFromSeed, signEnvelope, verifyEd25519 } from './crypto.mjs';
import {
  MAX_CONFIG_BYTES,
  ROLES,
  environmentOfConfig,
  isEnvelope,
  latestTag,
  pickContent,
  readJson,
  releasedKeys,
  unwrapEnvelope,
  validateSource,
} from './lib.mjs';

const { values: args } = parseArgs({
  options: {
    hosts: { type: 'string', default: 'hosts.json' },
    out: { type: 'string', default: 'config.json' },
    rutube: { type: 'string', default: '' },
    keys: { type: 'string', default: 'keys.json' },
  },
});

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

// Ключи — из секретов CI. Понятная ошибка: где взять и чем починить.
const signKey = process.env.SIGN_KEY;
const cipherKey = process.env.CIPHER_KEY;
if (!signKey) {
  fail(
    'нет SIGN_KEY (приватный ключ подписи). Он приходит из секрета репозитория ' +
      'SIGN_KEY_PROD / SIGN_KEY_DEV. Если секрета нет — проинициализируй ключи: ' +
      'в приложении запусти crypto/keys-dev.sh или crypto/keys-prod.sh → «Первичная настройка». Мануал: docs/features/dynamic-base-url/08_key_flow.md',
  );
}
if (!cipherKey) {
  fail(
    'нет CIPHER_KEY (ключ шифрования etag). Приходит из секрета CIPHER_KEY_PROD / CIPHER_KEY_DEV. ' +
      'Нет секрета — crypto/keys-dev.sh или crypto/keys-prod.sh → «Первичная настройка». Мануал: docs/features/dynamic-base-url/08_key_flow.md',
  );
}

let desired;
try {
  desired = validateSource(readJson(args.hosts));
} catch (error) {
  fail(error.message);
}

// Список видео Rutube (для etag) — из rutube.json окружения. Файла нет → etag не добавляем.
let videoIds = [];
if (args.rutube && existsSync(args.rutube)) {
  try {
    const rutube = readJson(args.rutube);
    videoIds = (rutube.videos ?? []).map((v) => v.id);
  } catch (error) {
    fail(`${args.rutube}: ${error.message}. Формат: {"videos":[{"id":"<32 hex>","token":"<метка>"}]}`);
  }
}

let etag;
try {
  etag = videoIds.length
    ? encodeVideoList(videoIds, Buffer.from(cipherKey, 'base64url'), ETAG_SALT)
    : undefined;
} catch (error) {
  fail(`etag не зашифровался: ${error.message}. Проверь CIPHER_KEY (должен быть base64url 32 байта)`);
}

const configPath = args.out;
const environment = environmentOfConfig(configPath);
if (!environment) fail(`${configPath}: неизвестный путь конфига (ожидается config.json или dev/config.json)`);

// --- белый список ключа подписи ---
let allowed;
try {
  allowed = releasedKeys(readJson(args.keys), environment);
} catch (error) {
  fail(
    `${args.keys}: ${error.message}. Это белый список ключей подписи, его ведёт crypto/keys-${environment}.sh ` +
      `(репозиторий приложения) → «Первичная настройка». Мануал: docs/features/dynamic-base-url/10_key_revocation.md`,
  );
}
let signPublic;
try {
  signPublic = publicFromSeed(signKey);
} catch (error) {
  fail(`SIGN_KEY не читается как ключ (${error.message}). Проверь секрет SIGN_KEY_${environment.toUpperCase()}`);
}
if (!allowed.includes(signPublic)) {
  fail(
    `ключ подписи из SIGN_KEY_${environment.toUpperCase()} (${signPublic.slice(0, 8)}…) не входит в ` +
      `${args.keys} → ${environment}.released. Его не знает выпущенная сборка приложения — подписанный им ` +
      `документ приложения отвергнут. Публикация остановлена, ничего не опубликовано. Проверь секрет и ` +
      `список: crypto/keys-${environment}.sh → «Статус».`,
  );
}

// --- опубликованное состояние: последний тег окружения ---
let published = null; // { tag, version, text, parsed, inner }
const latest = latestTag(environment, execFileSync('git', ['tag', '--list'], { encoding: 'utf8' }).split('\n'));
if (latest) {
  let text;
  try {
    text = execFileSync('git', ['show', `${latest.tag}:${configPath}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    fail(`в теге ${latest.tag} нет ${configPath} — теги публикации должен ставить только CI`);
  }
  let parsed;
  let inner;
  try {
    parsed = JSON.parse(text);
    inner = unwrapEnvelope(parsed);
  } catch (error) {
    fail(`${configPath} в теге ${latest.tag} не разбирается (${error.message})`);
  }
  if (inner?.version !== latest.version) {
    fail(`тег ${latest.tag} содержит конфиг с version ${inner?.version}: тег и конфиг не совпадают`);
  }
  // config.json в ветке обязан совпадать с опубликованным тегом: иначе его подменили руками
  // (или прошлая публикация прервалась между коммитом и тегом).
  if (existsSync(configPath) && readFileSync(configPath, 'utf8') !== text) {
    fail(
      `${configPath} в ветке не совпадает с опубликованным тегом ${latest.tag}: файл подменён руками или ` +
        `прошлая публикация прервалась. Откати файл: git checkout ${latest.tag} -- ${configPath}`,
    );
  }
  published = { ...latest, text, parsed, inner };
}

const current = published?.inner ?? null;
const signedByCurrentKey =
  published !== null &&
  isEnvelope(published.parsed) &&
  verifyEd25519(signPublic, fromB64url(published.parsed.p), fromB64url(published.parsed.s));
const sameContent = current && JSON.stringify(pickContent(current)) === JSON.stringify(desired);
const sameEtag = (current?.etag ?? undefined) === etag;
if (sameContent && sameEtag && signedByCurrentKey) {
  console.log(`Конфиг совпадает с опубликованной version ${current.version} (${published.tag}) — публиковать нечего.`);
  output('changed', 'false');
  output('version', current.version);
  process.exit(0);
}
const reason = !published
  ? 'первая публикация'
  : sameContent && sameEtag
    ? 'ключ подписи сменился — переподписываю тем же содержимым'
    : 'изменились хосты или список видео';
console.log(`Причина: ${reason}.`);

const inner = { version: (published?.version ?? 0) + 1, ...desired };
if (etag) inner.etag = etag;

// Подписываем ТОЧНЫЕ байты конфига; приложение разберёт их без пере-сериализации.
const payload = Buffer.from(JSON.stringify(inner), 'utf8');
let envelope;
try {
  envelope = signEnvelope(payload, signKey);
} catch (error) {
  fail(`подпись не получилась: ${error.message}. Проверь SIGN_KEY (base64url 32-байтовый seed)`);
}

const text = `${envelope}\n`;
const bytes = Buffer.byteLength(text, 'utf8');
if (bytes > MAX_CONFIG_BYTES) fail(`конверт ${bytes} байт > ${MAX_CONFIG_BYTES}: слишком много хостов`);

writeFileSync(configPath, text);
output('changed', 'true');
output('version', inner.version);

console.log(`version ${current?.version ?? '—'} → ${inner.version}, конверт ${bytes} байт`);
const flagMark = current?.endpoints_enabled === inner.endpoints_enabled ? '  ' : '* ';
console.log(`${flagMark}endpoints_enabled ${inner.endpoints_enabled}`);
for (const role of ROLES) {
  const before = (current?.[role] ?? []).join(', ');
  const after = desired[role].join(', ');
  console.log(`${before === after ? '  ' : '* '}${role.padEnd(10)} ${after}`);
}
console.log(
  `${sameEtag ? '  ' : '* '}etag       ${videoIds.length} видео` +
    `${videoIds.length ? ': ' + videoIds.join(', ') : ''}`,
);
