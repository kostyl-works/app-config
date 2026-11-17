// Golden-тест крипто CI. Те же константы проверяет Dart-сторона приложения
// (packages/services/endpoint_service/test/ci_parity_golden_test.dart). Расхождение любой из
// реализаций красит тест здесь или там — так ловится рассинхрон Dart↔JS.
//
// Ключи ТЕСТОВЫЕ (seed 0..31), не боевые.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import {
  COMPACT_DICTIONARY_V1,
  ETAG_SALT,
  compactEnvelope,
  encodeVideoList,
  rutubeDescription,
  signEnvelope,
  streamCipher,
  toB64url,
  unwrapAny,
  verifyEd25519,
} from './crypto.mjs';

const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const cipherKey = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
const salt = Buffer.from('salt-demo', 'utf8');
const message = '{"version":4,"api":["https://sapi.litnet.com"]}';
const videoId = 'b20cbc2918ae2a54d8d4eb2ba428d4e4';
const videoList = ['b20cbc2918ae2a54d8d4eb2ba428d4e4', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'];

const GOLDEN = {
  publicKey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',
  signature:
    '8XOuxRXXLlDT3Aj4fgYjBAoXudegKx8ibwm_fbIma96I_q8nnezFg88ms1anozeOOil__1ffY-WX_Gjg5kTbDw',
  envelope:
    '{"p":"eyJ2ZXJzaW9uIjo0LCJhcGkiOlsiaHR0cHM6Ly9zYXBpLmxpdG5ldC5jb20iXX0",' +
    '"s":"8XOuxRXXLlDT3Aj4fgYjBAoXudegKx8ibwm_fbIma96I_q8nnezFg88ms1anozeOOil__1ffY-WX_Gjg5kTbDw"}',
  streamCipherVec: 'pIw9eyFr4vg9cRONiTBeb4WxLR0kYCdjXsBSBEWMtaKsKZ5IWtmJ3D7Gjx5Jt7g',
  rutubeDescription:
    '~(2GpwF3KEAmLBAk6AIyKaK8z7rcivlpnnVS4Job46KsteRfTtACCZ8RXYQIN__lvxt7lgLnU5i-BafMJG5M9WR6' +
    'uiqf1vo_WKKSsB6nqxFCvUms_WANepO9iXH34X_6b545fZ1_4ckPZwrMks8A_JmmAJrovUoYmin60SWQWZ8HMax5' +
    'Tb7kjrzoVQyFToTnTnl4bdPDVuzvRCHKeWxcOQcZxuaWM)~',
  etag: 'mh15829q4yQLV2OBC4X6fugOR_X50Xf_dnzjvCjmymHJumkXPB8V7Trmx28n3aAzgQPcMqN_Hy2kQWNOadbnwzTxdUri-Kk',
  // Компактная форма для Varioqub: словарь (по SHA-256) и строки, которые обязана открыть Dart-сторона.
  compactDictionarySha256: 'f76afd71e57454c704bf968b8b13be5d5d60411af1417ec05516eb6838805043',
  compact:
    'ePlcIbASQwoqE4wQKUaNOaXYWgB9ThA0.8XOuxRXXLlDT3Aj4fgYjBAoXudegKx8ibwm_fbIma96I_q8nnezFg88ms1anozeOOil__1ffY-WX_Gjg5kTbDw',
  realisticMessage:
    '{"version":7,"endpoints_enabled":true,"api":["https://api-litnet.storytest.ru","https://api.mirror-lt.net"],' +
    '"cdn":["https://publiccdn.litnet.com"]}',
  realisticCompact:
    'ePlcIbASQwoqc8qDSgdZhV5uZlFRfpFuTokeUCHRPqgFAB4ENEc.' +
    'B-PhJQsPE60RPEzc3CDBoEUOd3v5TkZ3wa4UNDqcg7jvFBnOymdtAzA2_1iQ_43FzIci5ZT_DIJifVkd9wnHDQ',
};

test('публичный ключ из seed совпадает', () => {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const pub = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }))
    .export({ type: 'spki', format: 'der' })
    .subarray(-32);
  assert.equal(toB64url(pub), GOLDEN.publicKey);
});

test('подпись и конверт детерминированы', () => {
  const envelope = signEnvelope(Buffer.from(message, 'utf8'), seed);
  assert.equal(envelope, GOLDEN.envelope);
  assert.equal(JSON.parse(envelope).s, GOLDEN.signature);
});

test('поточный шифр совпадает', () => {
  assert.equal(toB64url(streamCipher(cipherKey, salt, Buffer.from(message, 'utf8'))), GOLDEN.streamCipherVec);
});

test('описание Rutube совпадает', () => {
  const envelope = signEnvelope(Buffer.from(message, 'utf8'), seed);
  assert.equal(rutubeDescription(envelope, cipherKey, videoId), GOLDEN.rutubeDescription);
});

test('etag совпадает', () => {
  assert.equal(encodeVideoList(videoList, cipherKey, ETAG_SALT), GOLDEN.etag);
});

test('словарь компактной формы заморожен (SHA-256 тот же, что у приложения)', () => {
  assert.equal(createHash('sha256').update(COMPACT_DICTIONARY_V1, 'utf8').digest('hex'), GOLDEN.compactDictionarySha256);
});

test('компактная форма: golden-строки открываются в исходный конфиг с той же подписью', () => {
  const simple = unwrapAny(GOLDEN.compact);
  assert.equal(simple.payload.toString('utf8'), message);
  assert.equal(toB64url(simple.signature), GOLDEN.signature);
  const realistic = unwrapAny(GOLDEN.realisticCompact);
  assert.equal(realistic.payload.toString('utf8'), GOLDEN.realisticMessage);
  assert.ok(verifyEd25519(GOLDEN.publicKey, realistic.payload, realistic.signature));
});

test('компактная форма: туда и обратно из конверта, обе формы читаются одинаково', () => {
  const envelope = signEnvelope(Buffer.from(GOLDEN.realisticMessage, 'utf8'), seed);
  const compact = compactEnvelope(envelope);
  assert.match(compact, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);
  assert.ok(compact.length < envelope.length / 2, `${compact.length} против ${envelope.length}`);
  assert.deepEqual(unwrapAny(compact), unwrapAny(envelope));
});

test('компактная форма: мусор и «zip-бомба» — null', () => {
  for (const bad of ['', 'abc', 'a.b', `a.${'A'.repeat(85)}`, `a.b.${'A'.repeat(86)}`, `!!.${'A'.repeat(86)}`, `AAAA.${'A'.repeat(86)}`]) {
    assert.equal(unwrapAny(bad), null, bad);
  }
  const bomb = deflateSync(Buffer.alloc(100_000, 0x20), { dictionary: Buffer.from(COMPACT_DICTIONARY_V1, 'utf8') });
  assert.equal(unwrapAny(`${toB64url(bomb)}.${'A'.repeat(86)}`), null);
});

test('боевые документы влезают в строковый флаг Varioqub (500 символов) с запасом', async () => {
  const { readFileSync } = await import('node:fs');
  for (const path of ['config.json', 'dev/config.json']) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').trim();
    if (!text.startsWith('{"p"')) continue;
    assert.ok(compactEnvelope(text).length <= 300, `${path}: ${compactEnvelope(text).length} символов`);
  }
});
