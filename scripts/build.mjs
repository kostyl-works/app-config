#!/usr/bin/env node
// Собирает следующий config.json из hosts.json. Если хосты (или список видео etag) отличаются
// от опубликованного, ставит version = опубликованная + 1. Номер версии людьми не правится.
//
// SAM-809: config.json — ПОДПИСАННЫЙ КОНВЕРТ {"p": base64url(bytes конфига), "s": base64url(
// подпись Ed25519)}. Приложение проверяет подпись ДО разбора и отвергает неподписанное
// (fail-closed). Внутри конфига поле etag — зашифрованный список videoId (для Rutube).
//
//   SIGN_KEY=<base64url seed> CIPHER_KEY=<base64url> \
//     node scripts/build.mjs --hosts hosts.json --out config.json --rutube rutube.json
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ETAG_SALT, encodeVideoList, signEnvelope } from './crypto.mjs';
import { MAX_CONFIG_BYTES, ROLES, pickContent, readInnerConfig, readJson, validateSource } from './lib.mjs';

const { values: args } = parseArgs({
  options: {
    hosts: { type: 'string', default: 'hosts.json' },
    out: { type: 'string', default: 'config.json' },
    rutube: { type: 'string', default: '' },
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
      'в приложении запусти crypto/keys.sh → init. Мануал: docs/features/dynamic-base-url/08_key_flow.md',
  );
}
if (!cipherKey) {
  fail(
    'нет CIPHER_KEY (ключ шифрования etag). Приходит из секрета CIPHER_KEY_PROD / CIPHER_KEY_DEV. ' +
      'Нет секрета — crypto/keys.sh → init. Мануал: docs/features/dynamic-base-url/08_key_flow.md',
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
let current;
try {
  current = readInnerConfig(configPath);
} catch (error) {
  fail(error.message);
}

const sameContent = current && JSON.stringify(pickContent(current)) === JSON.stringify(desired);
const sameEtag = (current?.etag ?? undefined) === etag;
if (sameContent && sameEtag) {
  console.log(`Конфиг совпадает с опубликованной version ${current.version} — публиковать нечего.`);
  output('changed', 'false');
  output('version', current.version); // при первом запуске тег может ещё не существовать
  process.exit(0);
}

const inner = { version: (current?.version ?? 0) + 1, ...desired };
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
