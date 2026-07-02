// Node port of tests/test_review_package.py — tests scripts/review-package.mjs.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'review-package.mjs');

function gitEnv(tmp) {
  return {
    ...process.env,
    HOME: join(tmp, 'home'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00',
    GIT_COMMITTER_DATE: '2020-01-01T00:00:00',
  };
}

function git(repo, env, ...args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8', env });
}

function commit(repo, env, msg, content) {
  writeFileSync(join(repo, 'a.txt'), content);
  git(repo, env, 'add', 'a.txt');
  assert.equal(git(repo, env, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg).status, 0);
  return git(repo, env, 'rev-parse', 'HEAD').stdout.trim();
}

function runPkg(repo, env, base, head, reviewDir) {
  const e = { ...env, CLAUDE_CREW_REVIEW_DIR: reviewDir };
  return spawnSync(process.execPath, [SCRIPT, base, head], { encoding: 'utf-8', env: e, cwd: repo });
}

function freshDir(label) {
  const d = join(tmpdir(), `rp-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

test('base..head review package with commits, diffstat, full diff', () => {
  const tmp = freshDir('base');
  try {
    const repo = join(tmp, 'repo'); mkdirSync(repo);
    const env = gitEnv(tmp);
    assert.equal(git(repo, env, 'init', '-q', '-b', 'main').status, 0);
    const base = commit(repo, env, 'c1', 'a\n');
    const head = commit(repo, env, 'c2', 'a\nb\n');
    const reviewDir = join(tmp, 'reviews');
    const r = runPkg(repo, env, base, head, reviewDir);
    assert.equal(r.status, 0, r.stderr);
    const printed = r.stdout.trim();
    assert.ok(printed.endsWith('-review.md'));
    assert.ok(printed.startsWith(reviewDir));
    const body = readFileSync(printed, 'utf-8');
    assert.ok(body.includes('Review package:'));
    assert.ok(body.includes('## Commits'));
    assert.ok(body.includes('c2'));
    const commitsBlock = body.split('## Commits')[1].split('## Diffstat')[0];
    const subjectLines = commitsBlock.split('\n').filter((ln) => ln.trim() && !ln.trim().startsWith('```'));
    const subjects = new Set(subjectLines.map((ln) => (ln.includes(' ') ? ln.slice(ln.indexOf(' ') + 1) : ln)));
    assert.ok(subjects.has('c2'));
    assert.ok(!subjects.has('c1'));
    assert.ok(body.includes('## Diffstat'));
    assert.ok(body.includes('## Full diff (-U10)'));
    assert.ok(body.includes('```diff'));
    assert.ok(body.includes('+b'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('MERGE_BASE resolves default branch and excludes base commit', () => {
  const tmp = freshDir('mergebase');
  try {
    const repo = join(tmp, 'repo'); mkdirSync(repo);
    const env = gitEnv(tmp);
    assert.equal(git(repo, env, 'init', '-q', '-b', 'main').status, 0);
    const base = commit(repo, env, 'c1', 'a\n');
    assert.equal(git(repo, env, 'checkout', '-q', '-b', 'feat').status, 0);
    commit(repo, env, 'c2', 'a\nb\n');
    const reviewDir = join(tmp, 'reviews');
    const r = runPkg(repo, env, 'MERGE_BASE', 'HEAD', reviewDir);
    assert.equal(r.status, 0, r.stderr);
    const printed = r.stdout.trim();
    const body = readFileSync(printed, 'utf-8');
    assert.ok(body.includes('+b'));
    assert.ok(body.includes('c2'));
    assert.ok(printed.includes(base.slice(0, 7)));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('MERGE_BASE resolves via origin/main when no local main exists', () => {
  const tmp = freshDir('origin');
  try {
    const remote = join(tmp, 'remote.git'); mkdirSync(remote);
    const env = gitEnv(tmp);
    assert.equal(git(remote, env, 'init', '-q', '--bare').status, 0);
    const src = join(tmp, 'src'); mkdirSync(src);
    assert.equal(git(src, env, 'init', '-q', '-b', 'main').status, 0);
    commit(src, env, 'c1', 'a\n');
    assert.equal(git(src, env, 'remote', 'add', 'origin', remote).status, 0);
    assert.equal(git(src, env, 'push', '-q', 'origin', 'main').status, 0);
    assert.equal(git(remote, env, 'symbolic-ref', 'HEAD', 'refs/heads/main').status, 0);
    const repo = join(tmp, 'repo');
    assert.equal(spawnSync('git', ['clone', '-q', remote, repo], { encoding: 'utf-8', env, cwd: tmp }).status, 0);
    assert.equal(git(repo, env, 'checkout', '-q', '-b', 'feat').status, 0);
    commit(repo, env, 'c2', 'a\nb\n');
    assert.equal(git(repo, env, 'branch', '-D', 'main').status, 0);
    assert.equal(git(repo, env, 'remote', 'set-head', 'origin', 'main').status, 0);
    const reviewDir = join(tmp, 'reviews');
    const r = runPkg(repo, env, 'MERGE_BASE', 'HEAD', reviewDir);
    assert.equal(r.status, 0, r.stderr);
    const body = readFileSync(r.stdout.trim(), 'utf-8');
    assert.ok(body.includes('+b'));
    assert.ok(body.includes('c2'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('not inside a git work tree exits 2', () => {
  const tmp = freshDir('empty');
  try {
    const empty = join(tmp, 'empty'); mkdirSync(empty);
    const env = gitEnv(tmp);
    const r = spawnSync(process.execPath, [SCRIPT, 'HEAD~1', 'HEAD'], { encoding: 'utf-8', env, cwd: empty });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes('not inside a git work tree'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('bad usage (one arg) exits 2', () => {
  const tmp = freshDir('badusage');
  try {
    const repo = join(tmp, 'repo'); mkdirSync(repo);
    const env = gitEnv(tmp);
    assert.equal(git(repo, env, 'init', '-q', '-b', 'main').status, 0);
    const r = spawnSync(process.execPath, [SCRIPT, 'HEAD'], { encoding: 'utf-8', env, cwd: repo });
    assert.equal(r.status, 2);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});