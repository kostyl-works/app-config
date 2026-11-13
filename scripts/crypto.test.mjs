// Golden-тест крипто CI. Те же константы проверяет Dart-сторона приложения
// (packages/services/endpoint_service/test/ci_parity_golden_test.dart). Расхождение любой из
// реализаций красит тест здесь или там — так ловится рассинхрон Dart↔JS.
//
// Ключи ТЕСТОВЫЕ (seed 0..31), не боевые.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import test from 'node:test';
import {
  ETAG_SALT,
  encodeVideoList,
  rutubeDescription,
  signEnvelope,
  streamCipher,
  toB64url,
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
