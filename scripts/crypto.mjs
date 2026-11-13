// Крипто документа адресов (SAM-809). Должно совпадать байт-в-байт с Dart-стороной
// приложения (packages/services/endpoint_service/lib/src/crypto/*). Без внешних зависимостей.
//
// - Подпись Ed25519 над ТОЧНЫМИ байтами конфига (приватник — сырой 32-байтовый seed base64url,
//   как его кладёт crypto/keys.sh: последние 32 байта PKCS8 DER).
// - Поточный шифр: keystream = HMAC-SHA256(key, salt || uint32be(index)) по 32 байта, XOR.
// - Конверт {"p": base64url(bytes конфига), "s": base64url(подпись)}.
import { createHmac, createPrivateKey, sign as edSign } from 'node:crypto';

const BLOCK = 32;
// Префикс PKCS8 DER для Ed25519-приватника (16 байт) + 32 байта seed = валидный ключ для Node.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

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

/** Подпись Ed25519 над message. seed — сырой 32-байтовый приватник (base64url или Buffer). */
export function signEd25519(seed, message) {
  const raw = Buffer.isBuffer(seed) ? seed : fromB64url(seed);
  if (raw.length !== 32) throw new Error(`приватный ключ подписи должен быть 32 байта, получено ${raw.length}`);
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, raw]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const msg = Buffer.isBuffer(message) ? message : Buffer.from(message);
  return edSign(null, msg, key); // Ed25519: алгоритм null, подпись детерминирована (RFC 8032)
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
