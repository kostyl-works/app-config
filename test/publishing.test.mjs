import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fromB64url, publicFromSeed, verifyEd25519 } from '../scripts/crypto.mjs';
import { unwrapEnvelope } from '../scripts/lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = {
  endpoints_enabled: true,
  ...Object.fromEntries(['api', 'superapi', 'web', 'oauth', 'cdn', 'analytics']
    .map((role) => [role, [`https://${role}.example.test`]])),
};

// Тестовые ключи подписи/шифрования (SAM-809): build.mjs требует их всегда.
const SIGN_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64url');
const SIGN_KEY_2 = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 3 + 1) & 0xff)).toString('base64url');
const CIPHER_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)).toString('base64url');
const PUB = publicFromSeed(SIGN_KEY);
const PUB_2 = publicFromSeed(SIGN_KEY_2);

/** keys.json: белый список ключей подписи по окружениям. */
function keysJson(released = [PUB]) {
  const env = { released, next: released, current: released[0] };
  return { prod: env, dev: env };
}

/** Опубликованный config.json → внутренний конфиг (конверт разворачивается, legacy — как есть). */
function inner(text) {
  return unwrapEnvelope(JSON.parse(text));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function run(cwd, command, args, env = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...env,
    },
  });
}

function ok(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function git(cwd, ...args) {
  return ok(run(cwd, 'git', args));
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'app-config-publish-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const remote = join(dir, 'remote.git');
  mkdirSync(repo);
  git(dir, 'init', '--bare', '--initial-branch=main', remote);
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Config test');
  git(repo, 'config', 'user.email', 'config-test@example.test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'tag.gpgsign', 'false');
  git(repo, 'remote', 'add', 'origin', remote);
  writeJson(join(repo, 'hosts.json'), source);
  writeJson(join(repo, 'config.json'), { version: 8, ...source });
  writeJson(join(repo, 'dev/hosts.json'), source);
  writeJson(join(repo, 'dev/config.json'), { version: 1, ...source });
  writeJson(join(repo, 'keys.json'), keysJson());
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'Initial configs');
  git(repo, 'tag', '1.0.8');
  git(repo, 'push', '-q', '-u', 'origin', 'main', 'refs/tags/1.0.8');

  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PURGE_LOG"\n');
  chmodSync(join(bin, 'curl'), 0o755);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    PURGE_LOG: join(dir, 'purge.log'),
    GITHUB_REPOSITORY: 'example/app-config',
    GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
    MESSAGE: 'Hosts update with literal `backticks` and $(substitution)',
  };
  return { dir, repo, remote, env };
}

function commit(repo, path, value) {
  writeJson(join(repo, path), value);
  git(repo, 'add', '--', path);
  git(repo, 'commit', '-qm', `Update ${path}`);
  return git(repo, 'rev-parse', 'HEAD');
}

function select(f, name, event, ref = 'refs/heads/main') {
  const eventPath = join(f.dir, 'event.json');
  const outputPath = join(f.dir, 'selected.txt');
  writeJson(eventPath, event);
  writeFileSync(outputPath, '');
  const result = run(f.repo, process.execPath, [join(root, 'scripts/select-environments.mjs')], {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: name,
    GITHUB_REF: ref,
    GITHUB_OUTPUT: outputPath,
  });
  return { result, output: readFileSync(outputPath, 'utf8').trim() };
}

/** Запуск build.mjs как есть: результат процесса и выходы GITHUB_OUTPUT. */
function buildRaw(f, environment, signKey = SIGN_KEY, { cipherKey = CIPHER_KEY, rutube = false } = {}) {
  const prefix = environment === 'dev' ? 'dev/' : '';
  const outputPath = join(f.dir, 'build-output.txt');
  writeFileSync(outputPath, '');
  const result = run(f.repo, process.execPath, [
    join(root, 'scripts/build.mjs'), '--hosts', `${prefix}hosts.json`, '--out', `${prefix}config.json`,
    ...(rutube ? ['--rutube', `${prefix}rutube.json`] : []),
  ], { GITHUB_OUTPUT: outputPath, SIGN_KEY: signKey, CIPHER_KEY: cipherKey });
  const outputs = readFileSync(outputPath, 'utf8').trim();
  return { result, outputs: outputs ? Object.fromEntries(outputs.split('\n').map((line) => line.split('='))) : {} };
}

function build(f, environment, signKey = SIGN_KEY) {
  const { result, outputs } = buildRaw(f, environment, signKey);
  ok(result);
  return outputs;
}

function release(f, environment, version) {
  return run(f.repo, 'bash', [join(root, 'scripts/release.sh')], {
    ...f.env, ENVIRONMENT: environment, VERSION: String(version), PURGE_RETRY_DELAY: '0',
  });
}

test('push event is rejected: publication is manual only', (t) => {
  const f = fixture(t);
  const initial = git(f.repo, 'rev-parse', 'HEAD');
  const prod = commit(f.repo, 'hosts.json', { ...source, api: ['https://new-api.example.test'] });
  const selected = select(f, 'push', { before: initial, after: prod });
  assert.equal(selected.result.status, 1);
  assert.match(selected.result.stderr, /Автопубликации нет/);
  assert.equal(selected.output, '');
});

test('manual selection accepts exactly one environment and rejects other branches or invalid inputs', (t) => {
  const f = fixture(t);
  for (const environment of ['dev', 'prod']) {
    const selected = select(f, 'workflow_dispatch', { inputs: { environment } });
    ok(selected.result);
    assert.equal(selected.output, `environments=["${environment}"]`);
  }
  for (const event of [{ inputs: {} }, { inputs: { environment: 'staging' } }]) {
    assert.equal(select(f, 'workflow_dispatch', event).result.status, 1);
  }
  const branch = select(f, 'workflow_dispatch', { inputs: { environment: 'dev' } }, 'refs/heads/development');
  assert.equal(branch.result.status, 1);
  assert.match(branch.result.stderr, /только из main/);
});

test('dev bootstrap, updates, retries and prod updates publish independently to a local remote', (t) => {
  const f = fixture(t);
  const originalProd = readFileSync(join(f.repo, 'config.json'), 'utf8');
  // У dev ещё нет тега: первая публикация, конфиг становится подписанным конвертом.
  assert.deepEqual(build(f, 'dev'), { changed: 'true', version: '1' });
  ok(release(f, 'dev', 1));
  assert.equal(git(f.repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'dev/config.json');
  assert.deepEqual(inner(git(f.remote, 'show', 'dev-1.0.1:dev/config.json')), { version: 1, ...source });
  assert.equal(readFileSync(join(f.repo, 'config.json'), 'utf8'), originalProd);
  assert.match(readFileSync(f.env.GITHUB_STEP_SUMMARY, 'utf8'), /@dev-1\.0\.1\/dev\/config\.json/);
  // Varioqub: имя флага dev и компактная форма (подписанный {p,s} не влез бы в лимит флага).
  assert.match(readFileSync(f.env.GITHUB_STEP_SUMMARY, 'utf8'), /`endpoint_document_dev`/);
  assert.match(readFileSync(f.env.GITHUB_STEP_SUMMARY, 'utf8'), /\n[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}\n/);

  commit(f.repo, 'dev/hosts.json', { ...source, api: ['https://dev-api.example.test'] });
  git(f.repo, 'push', '-q', 'origin', 'main');
  assert.deepEqual(build(f, 'dev'), { changed: 'true', version: '2' });
  ok(release(f, 'dev', 2));
  assert.equal(git(f.repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'dev/config.json');
  assert.equal(readFileSync(join(f.repo, 'config.json'), 'utf8'), originalProd);
  assert.equal(inner(git(f.remote, 'show', 'dev-1.0.2:dev/config.json')).version, 2);
  assert.equal(git(f.remote, 'tag', '--list', '1.0.*'), '1.0.8');
  const afterDev = git(f.repo, 'rev-parse', 'HEAD');
  assert.deepEqual(build(f, 'dev'), { changed: 'false', version: '2' });
  ok(release(f, 'dev', 2));
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), afterDev);

  const devConfig = readFileSync(join(f.repo, 'dev/config.json'), 'utf8');
  commit(f.repo, 'hosts.json', { ...source, api: ['https://prod-api.example.test'] });
  git(f.repo, 'push', '-q', 'origin', 'main');
  assert.deepEqual(build(f, 'prod'), { changed: 'true', version: '9' });
  ok(release(f, 'prod', 9));
  assert.equal(git(f.repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'config.json');
  assert.equal(readFileSync(join(f.repo, 'dev/config.json'), 'utf8'), devConfig);
  assert.equal(inner(git(f.remote, 'show', '1.0.9:config.json')).version, 9);
  const afterProd = git(f.repo, 'rev-parse', 'HEAD');
  assert.deepEqual(build(f, 'prod'), { changed: 'false', version: '9' });
  ok(release(f, 'prod', 9));
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), afterProd);

  // Кэш jsDelivr сбрасывается на каждую новую публикацию: dev — @main, prod — @1.
  const purges = readFileSync(f.env.PURGE_LOG, 'utf8').trim().split('\n');
  assert.equal(purges.filter((line) => /@1\/config\.json$/.test(line)).length, 1);
  assert.equal(purges.filter((line) => /@main\/dev\/config\.json$/.test(line)).length, 2);
});

test('release refuses a conflicting tag or version without changing the remote', (t) => {
  const f = fixture(t);
  const remoteHead = git(f.remote, 'rev-parse', 'main');
  assert.deepEqual(build(f, 'dev'), { changed: 'true', version: '1' });
  // Пока собирали, кто-то поставил тег dev-1.0.1 на другой конфиг.
  git(f.repo, 'tag', 'dev-1.0.1');
  git(f.repo, 'push', '-q', 'origin', 'refs/tags/dev-1.0.1');
  const originalTag = git(f.remote, 'rev-parse', 'dev-1.0.1');
  const collision = release(f, 'dev', 1);
  assert.equal(collision.status, 1);
  assert.match(collision.stdout, /уже существует с другим конфигом/);
  assert.equal(git(f.remote, 'rev-parse', 'dev-1.0.1'), originalTag);
  assert.equal(git(f.remote, 'rev-parse', 'main'), remoteHead);
  assert.equal(release(f, 'dev', 2).status, 1);
  assert.equal(release(f, 'staging', 1).status, 1);
  assert.equal(git(f.remote, 'rev-parse', 'main'), remoteHead);
});

test('new dev config starts at version 1 and validates input even without host probing', (t) => {
  const f = fixture(t);
  rmSync(join(f.repo, 'dev/config.json'));
  assert.deepEqual(build(f, 'dev'), { changed: 'true', version: '1' });
  writeJson(join(f.repo, 'dev/hosts.json'), { ...source, api: ['http://invalid.example.test'] });
  const { result } = buildRaw(f, 'dev');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /только https/);
});

test('signing key outside keys.json is refused before anything is written', (t) => {
  const f = fixture(t);
  writeJson(join(f.repo, 'keys.json'), keysJson([PUB_2]));
  const before = readFileSync(join(f.repo, 'dev/config.json'), 'utf8');
  const { result, outputs } = buildRaw(f, 'dev');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /не входит в keys\.json → dev\.released/);
  assert.deepEqual(outputs, {});
  assert.equal(readFileSync(join(f.repo, 'dev/config.json'), 'utf8'), before);
});

test('config.json edited in the branch (not matching the tag) stops the build', (t) => {
  const f = fixture(t);
  build(f, 'dev');
  ok(release(f, 'dev', 1));
  // Кто-то с правом push подложил огромную версию прямо в ветку.
  writeJson(join(f.repo, 'dev/config.json'), { version: 9007199254740991, ...source });
  const { result } = buildRaw(f, 'dev');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /не совпадает с опубликованным тегом dev-1\.0\.1/);
});

test('jsDelivr purge failure warns after 3 attempts but does not fail the release', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'bin/curl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PURGE_LOG"\nexit 22\n');
  build(f, 'dev');
  const result = release(f, 'dev', 1);
  ok(result);
  assert.match(result.stdout, /::warning::Кэш jsDelivr не сброшен/);
  assert.equal(readFileSync(f.env.PURGE_LOG, 'utf8').trim().split('\n').length, 3);
  assert.equal(inner(git(f.remote, 'show', 'dev-1.0.1:dev/config.json')).version, 1);
});

test('key rotation re-signs the same content with version + 1', (t) => {
  const f = fixture(t);
  build(f, 'dev');
  ok(release(f, 'dev', 1));
  // Ротация: CI теперь подписывает ключом 2, он уже в списке выпущенной сборки.
  writeJson(join(f.repo, 'keys.json'), keysJson([PUB, PUB_2]));
  const { result, outputs } = buildRaw(f, 'dev', SIGN_KEY_2);
  ok(result);
  assert.deepEqual(outputs, { changed: 'true', version: '2' });
  assert.match(result.stdout, /ключ подписи сменился/);
  const envelope = JSON.parse(readFileSync(join(f.repo, 'dev/config.json'), 'utf8'));
  assert.ok(verifyEd25519(PUB_2, fromB64url(envelope.p), fromB64url(envelope.s)));
  assert.deepEqual(inner(JSON.stringify(envelope)), { version: 2, ...source });
});

test('new cipher key with the same video list: reason says so, version + 1', (t) => {
  const f = fixture(t);
  const videos = { videos: [{ id: 'b'.repeat(32), token: 'dev' }] };
  commit(f.repo, 'dev/rutube.json', videos);
  git(f.repo, 'push', '-q', 'origin', 'main');
  const first = buildRaw(f, 'dev', SIGN_KEY, { rutube: true });
  ok(first.result);
  ok(release(f, 'dev', 1));
  // Выпуск ключей с нуля: новый ключ шифрования (и подписи) — шифротекст etag другой, список тот же.
  const CIPHER_KEY_2 = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 5 + 11) & 0xff)).toString('base64url');
  commit(f.repo, 'keys.json', keysJson([PUB_2]));
  git(f.repo, 'push', '-q', 'origin', 'main');
  const resigned = buildRaw(f, 'dev', SIGN_KEY_2, { cipherKey: CIPHER_KEY_2, rutube: true });
  ok(resigned.result);
  assert.deepEqual(resigned.outputs, { changed: 'true', version: '2' });
  assert.match(resigned.result.stdout, /Причина: сменился ключ шифрования — хосты и список видео те же, перешифровываю etag и переподписываю новым ключом/);
  // А если список видео правда изменился — так и пишем.
  ok(release(f, 'dev', 2));
  commit(f.repo, 'dev/rutube.json', { videos: [...videos.videos, { id: 'c'.repeat(32), token: 'dev' }] });
  const changed = buildRaw(f, 'dev', SIGN_KEY_2, { cipherKey: CIPHER_KEY_2, rutube: true });
  ok(changed.result);
  assert.match(changed.result.stdout, /Причина: изменились хосты или список видео/);
});
