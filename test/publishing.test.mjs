import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = {
  endpoints_enabled: true,
  ...Object.fromEntries(['api', 'superapi', 'web', 'oauth', 'cdn', 'analytics']
    .map((role) => [role, [`https://${role}.example.test`]])),
};

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

function build(f, environment) {
  const prefix = environment === 'dev' ? 'dev/' : '';
  const outputPath = join(f.dir, 'build-output.txt');
  writeFileSync(outputPath, '');
  ok(run(f.repo, process.execPath, [
    join(root, 'scripts/build.mjs'), '--hosts', `${prefix}hosts.json`, '--out', `${prefix}config.json`,
  ], { GITHUB_OUTPUT: outputPath }));
  return Object.fromEntries(readFileSync(outputPath, 'utf8').trim().split('\n').map((line) => line.split('=')));
}

function release(f, environment, version) {
  return run(f.repo, 'bash', [join(root, 'scripts/release.sh')], {
    ...f.env, ENVIRONMENT: environment, VERSION: String(version),
  });
}

test('push selects only changed sources across all commits; first push selects both', (t) => {
  const f = fixture(t);
  const initial = git(f.repo, 'rev-parse', 'HEAD');
  const dev = commit(f.repo, 'dev/hosts.json', { ...source, endpoints_enabled: false });
  let selected = select(f, 'push', { before: initial, after: dev });
  ok(selected.result);
  assert.equal(selected.output, 'environments=["dev"]');

  const prod = commit(f.repo, 'hosts.json', { ...source, api: ['https://new-api.example.test'] });
  selected = select(f, 'push', { before: dev, after: prod });
  ok(selected.result);
  assert.equal(selected.output, 'environments=["prod"]');
  selected = select(f, 'push', { before: initial, after: prod });
  ok(selected.result);
  assert.equal(selected.output, 'environments=["prod","dev"]');

  const other = commit(f.repo, 'unrelated.json', {});
  selected = select(f, 'push', { before: prod, after: other });
  ok(selected.result);
  assert.equal(selected.output, 'environments=[]');
  selected = select(f, 'push', { before: '0'.repeat(40), after: other });
  ok(selected.result);
  assert.equal(selected.output, 'environments=["prod","dev"]');
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
  assert.equal(select(f, 'push', { before: '--help', after: 'invalid' }).result.status, 1);
});

test('dev bootstrap, updates, retries and prod updates publish independently to a local remote', (t) => {
  const f = fixture(t);
  const originalProd = readFileSync(join(f.repo, 'config.json'), 'utf8');
  const initial = git(f.repo, 'rev-parse', 'HEAD');
  assert.deepEqual(build(f, 'dev'), { changed: 'false', version: '1' });
  ok(release(f, 'dev', 1));
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), initial);
  assert.equal(git(f.remote, 'show', 'dev-1.0.1:dev/config.json'), JSON.stringify({ version: 1, ...source }));
  assert.equal(readFileSync(join(f.repo, 'config.json'), 'utf8'), originalProd);
  assert.match(readFileSync(f.env.GITHUB_STEP_SUMMARY, 'utf8'), /@dev-1\.0\.1\/dev\/config\.json/);

  commit(f.repo, 'dev/hosts.json', { ...source, api: ['https://dev-api.example.test'] });
  git(f.repo, 'push', '-q', 'origin', 'main');
  assert.deepEqual(build(f, 'dev'), { changed: 'true', version: '2' });
  ok(release(f, 'dev', 2));
  assert.equal(git(f.repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'dev/config.json');
  assert.equal(readFileSync(join(f.repo, 'config.json'), 'utf8'), originalProd);
  assert.equal(JSON.parse(git(f.remote, 'show', 'dev-1.0.2:dev/config.json')).version, 2);
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
  assert.equal(JSON.parse(git(f.remote, 'show', '1.0.9:config.json')).version, 9);
  const afterProd = git(f.repo, 'rev-parse', 'HEAD');
  assert.deepEqual(build(f, 'prod'), { changed: 'false', version: '9' });
  ok(release(f, 'prod', 9));
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), afterProd);
  const purges = readFileSync(f.env.PURGE_LOG, 'utf8').trim().split('\n');
  assert.equal(purges.length, 1);
  assert.match(purges[0], /@1\/config\.json$/);
});

test('release refuses a conflicting tag or version without changing the remote', (t) => {
  const f = fixture(t);
  const remoteHead = git(f.remote, 'rev-parse', 'main');
  git(f.repo, 'tag', 'dev-1.0.2');
  git(f.repo, 'push', '-q', 'origin', 'refs/tags/dev-1.0.2');
  const originalTag = git(f.remote, 'rev-parse', 'dev-1.0.2');
  writeJson(join(f.repo, 'dev/hosts.json'), { ...source, endpoints_enabled: false });
  assert.deepEqual(build(f, 'dev'), { changed: 'true', version: '2' });
  const collision = release(f, 'dev', 2);
  assert.equal(collision.status, 1);
  assert.match(collision.stdout, /уже существует с другим конфигом/);
  assert.equal(git(f.remote, 'rev-parse', 'dev-1.0.2'), originalTag);
  assert.equal(git(f.remote, 'rev-parse', 'main'), remoteHead);
  assert.equal(release(f, 'dev', 3).status, 1);
  assert.equal(release(f, 'staging', 1).status, 1);
  assert.equal(git(f.remote, 'rev-parse', 'main'), remoteHead);
});

test('new dev config starts at version 1 and validates input even without host probing', (t) => {
  const f = fixture(t);
  rmSync(join(f.repo, 'dev/config.json'));
  assert.deepEqual(build(f, 'dev'), { changed: 'true', version: '1' });
  writeJson(join(f.repo, 'dev/hosts.json'), { ...source, api: ['http://invalid.example.test'] });
  const result = run(f.repo, process.execPath, [
    join(root, 'scripts/build.mjs'), '--hosts', 'dev/hosts.json', '--out', 'dev/config.json',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /только https/);
});
