// Крипто документа адресов (SAM-809). Должно совпадать байт-в-байт с Dart-стороной
// приложения (packages/services/endpoint_service/lib/src/crypto/*). Без внешних зависимостей.
//
// - Подпись Ed25519 над ТОЧНЫМИ байтами конфига (приватник — сырой 32-байтовый seed base64url,
//   как его кладут crypto/keys-dev.sh / keys-prod.sh: последние 32 байта PKCS8 DER).
// - Поточный шифр: keystream = HMAC-SHA256(key, salt || uint32be(index)) по 32 байта, XOR.
// - Конверт {"p": base64url(bytes конфига), "s": base64url(подпись)}.
// - Компактная форма для Varioqub "<z>.<s>" (сжатие со словарём) — внизу файла.
import { createHmac, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const BLOCK = 32;
// Префикс PKCS8 DER для Ed25519-приватника (16 байт) + 32 байта seed = валидный ключ для Node.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
// Префикс SPKI DER для Ed25519-открытого ключа (12 байт) + 32 байта ключа.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** base64url-строка → Buffer. Принимает и с padding, и без. */
export function fromB64url(value) {
  return Buffer.from(String(value), 'base64url');
}

/** Buffer → base64url без padding (как у Node; Dart при чтении делает normalize). */
export function toB64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * data XOR keystream(key, salt). Длина результата равна длине data.
 * Точная копия StreamCipher.apply на Dart: счётчик 4 байта big-endian, блоки по 32.
 */
export function streamCipher(key, salt, data) {
  const k = Buffer.isBuffer(key) ? key : fromB64url(key);
  const s = Buffer.isBuffer(salt) ? salt : Buffer.from(salt);
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const out = Buffer.alloc(d.length);
  let index = 0;
  let blockPos = BLOCK;
  let block = Buffer.alloc(0);
  for (let i = 0; i < d.length; i++) {
    if (blockPos === BLOCK) {
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(index++, 0);
      block = createHmac('sha256', k).update(Buffer.concat([s, counter])).digest();
      blockPos = 0;
    }
    out[i] = d[i] ^ block[blockPos++];
  }
  return out;
}

/** Приватник Node из сырого 32-байтового seed (base64url или Buffer). */
function privateKeyFromSeed(seed) {
  const raw = Buffer.isBuffer(seed) ? seed : fromB64url(seed);
  if (raw.length !== 32) throw new Error(`приватный ключ подписи должен быть 32 байта, получено ${raw.length}`);
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]), format: 'der', type: 'pkcs8' });
}

/** Подпись Ed25519 над message. seed — сырой 32-байтовый приватник (base64url или Buffer). */
export function signEd25519(seed, message) {
  const msg = Buffer.isBuffer(message) ? message : Buffer.from(message);
  return edSign(null, msg, privateKeyFromSeed(seed)); // Ed25519: алгоритм null, подпись детерминирована (RFC 8032)
}

/** Открытый ключ (сырые 32 байта, base64url) из закрытого seed — как его печатают crypto/keys-dev.sh / keys-prod.sh. */
export function publicFromSeed(seed) {
  const spki = createPublicKey(privateKeyFromSeed(seed)).export({ type: 'spki', format: 'der' });
  return toB64url(spki.subarray(-32));
}

/** Проверка подписи Ed25519. publicKey — сырые 32 байта (base64url или Buffer). Ошибка ключа — false. */
export function verifyEd25519(publicKey, message, signature) {
  try {
    const raw = Buffer.isBuffer(publicKey) ? publicKey : fromB64url(publicKey);
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
    const msg = Buffer.isBuffer(message) ? message : Buffer.from(message);
    const sig = Buffer.isBuffer(signature) ? signature : fromB64url(signature);
    return edVerify(null, msg, key, sig);
  } catch {
    return false;
  }
}

/**
 * Конверт для подписанного конфига. payloadBytes — ТОЧНЫЕ байты, которые подписываем и которые
 * приложение потом разбирает без пере-сериализации. Возвращает строку JSON конверта.
 */
export function wrapEnvelope(payloadBytes, signatureBytes) {
  return JSON.stringify({ p: toB64url(payloadBytes), s: toB64url(signatureBytes) });
}

/** Подписать байты конфига и собрать конверт одной операцией. */
export function signEnvelope(payloadBytes, seed) {
  const payload = Buffer.isBuffer(payloadBytes) ? payloadBytes : Buffer.from(payloadBytes);
  return wrapEnvelope(payload, signEd25519(seed, payload));
}

/** Значение поля etag: зашифрованный список videoId. salt — публичная константа ETAG_SALT. */
export function encodeVideoList(videoIds, cipherKey, salt) {
  const plain = Buffer.from(JSON.stringify(videoIds), 'utf8');
  return toB64url(streamCipher(cipherKey, salt, plain));
}

/** Публичная соль поля etag (совпадает с приложением). */
export const ETAG_SALT = Buffer.from('etag', 'utf8');

// Метки payload в описании Rutube. Условия: (1) вне алфавита base64url, иначе встретятся внутри
// зашифрованного base64 и обрежут его; (2) Rutube НЕ меняет их при сохранении описания — `<`/`>`
// он подменяет Unicode-двойниками, а `~ ( )` оставляет как есть (проверено на дев-видео).
export const RUTUBE_BEGIN = '~(';
export const RUTUBE_END = ')~';

/**
 * Описание видео Rutube: конверт [envelopeString] шифруется ключом с солью = videoId, base64url,
 * между метками. Приложение (RutubeEndpointSource) делает обратное.
 */
export function rutubeDescription(envelopeString, cipherKey, videoId) {
  const cipher = streamCipher(cipherKey, Buffer.from(videoId, 'utf8'), Buffer.from(envelopeString, 'utf8'));
  return `${RUTUBE_BEGIN}${toB64url(cipher)}${RUTUBE_END}`;
}

// --- Компактная форма конверта — для Varioqub (строковый флаг не длиннее 500 символов) ---
// "<z>.<s>": z = base64url(zlib RFC 1950 (байты конфига) со словарём COMPACT_DICTIONARY_V1),
// s — ТА ЖЕ подпись над НЕсжатыми байтами, что в {p,s}. Точки нет в алфавите base64url, поэтому
// разбор однозначен. Подписанный {p,s} — ~570 символов, компактный — ~180. Формат zlib, а не raw
// deflate: заголовок несёт отпечаток словаря (FDICT), без него dart:io словарь не подставляет.
// Словарь ЗАМОРОЖЕН: выпущенные сборки распаковывают только им. Другой словарь — другой формат
// (три части с меткой формата впереди); эту форму не менять. Совпадение со словарём приложения
// (DocumentCodec.compactDictionaryV1) проверяет SHA-256 в golden-тестах обеих сторон.
export const COMPACT_DICTIONARY_V1 =
  '","https://' +
  'https://audio.litnet.com https://api-audio.litnet.com https://superapi.litnet.com https://id.litnet.com ' +
  'https://storytest.ru https://dev-api.storytest.ru "endpoints_enabled":false ' +
  '{"version":1,"endpoints_enabled":true,"api":["https://api-litnet.storytest.ru"],' +
  '"superapi":["https://superapi-litnet.storytest.ru"],"web":["https://litnet.storytest.ru"],' +
  '"oauth":["https://id-litnet.storytest.ru"],"cdn":["https://publiccdn.litnet.com"],' +
  '"analytics":["https://osc.litnet.com"],"etag":"';

/** Потолок распаковки компактной формы, байт (защита от «zip-бомбы»; конфиг — сотни байт). */
export const COMPACT_MAX_BYTES = 8192;

const compactDictionary = () => Buffer.from(COMPACT_DICTIONARY_V1, 'utf8');

/** Конверт {p,s} (строка) → компактная форма "<z>.<s>" для Varioqub. */
export function compactEnvelope(envelopeText) {
  const envelope = JSON.parse(envelopeText);
  if (typeof envelope?.p !== 'string' || typeof envelope?.s !== 'string') throw new Error('это не конверт {p,s}');
  const z = deflateSync(fromB64url(envelope.p), { level: 9, memLevel: 9, dictionary: compactDictionary() });
  return `${toB64url(z)}.${envelope.s}`;
}

/**
 * Любая форма конверта ({p,s} или "<z>.<s>") → {payload, signature}; null — не конверт, битый
 * base64, не распаковалось или распаковка больше COMPACT_MAX_BYTES.
 */
export function unwrapAny(text) {
  const raw = String(text ?? '').trim();
  if (raw.startsWith('{')) {
    try {
      const envelope = JSON.parse(raw);
      if (typeof envelope?.p !== 'string' || typeof envelope?.s !== 'string') return null;
      return { payload: fromB64url(envelope.p), signature: fromB64url(envelope.s) };
    } catch {
      return null;
    }
  }
  const parts = raw.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{86}$/.test(parts[1])) return null;
  try {
    const payload = inflateSync(fromB64url(parts[0]), { dictionary: compactDictionary(), maxOutputLength: COMPACT_MAX_BYTES });
    return payload.length ? { payload, signature: fromB64url(parts[1]) } : null;
  } catch {
    return null;
  }
}
