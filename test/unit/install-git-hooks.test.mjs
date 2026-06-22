// Node port of tests/test_install_git_hooks.py — tests scripts/install-git-hooks.mjs.
// The installer now writes a Node-shebang wrapper into .git/hooks/pre-push that
// execs scripts/git-hooks/pre-push.mjs (the old .sh hook was byte-copied; the
// .mjs hook is the source of truth and the wrapper keeps .git/hooks executable).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, readFileSync, existsSync, chmodSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'install-git-hooks.mjs');
const SRC_HOOK = join(REPO, 'scripts', 'git-hooks', 'pre-push.mjs');

function gitEnv(tmp) {
  return { ...process.env, HOME: join(tmp, 'home'), GIT_CONFIG_NOSYSTEM: '1' };
}

function makeRepo(tmp) {
  const repo = join(tmp, 'repo'); mkdirSync(repo, { recursive: true });
  const env = gitEnv(tmp);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo, env }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repo, env }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.name', 't'], { cwd: repo, env }).status, 0);
  return { repo, env };
}

function freshDir(label) {
  const d = join(tmpdir(), `igh-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function isExecutable(p) {
  try { return (statSync(p).mode & 0o111) !== 0; } catch { return false; }
}

test('installs a working, executable pre-push hook wrapper', () => {
  const tmp = freshDir('install');
  try {
    const { repo, env } = makeRepo(tmp);
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf-8', env });
    assert.equal(r.status, 0, r.stderr);
    const dest = join(repo, '.git', 'hooks', 'pre-push');
    assert.ok(existsSync(dest));
    // The Unix exec bit and a direct spawnSync(dest) of the shebang wrapper are
    // POSIX-only: Windows has no Unix exec bit (mode & 0o111 is always 0), and
    // Node cannot exec a `#!/usr/bin/env node` shebang script directly without
    // a shell. On Windows git invokes hooks via git-bash (sh), so the hook
    // works in real use; we just cannot assert those two facts here.
    if (process.platform !== 'win32') assert.ok(isExecutable(dest));
    const destText = readFileSync(dest, 'utf-8');
    // Wrapper is a Node script that execs the real .mjs hook source.
    assert.ok(destText.startsWith('#!/usr/bin/env node'));
    assert.ok(destText.includes('pre-push.mjs'));
    assert.ok(r.stdout.includes('Installed pre-push secret-scan hook'));
    assert.ok(r.stdout.includes('To remove:'));

    if (process.platform !== 'win32') {
      // The installed hook must actually work: clean push exits 0.
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      assert.equal(spawnSync('git', ['add', 'a.txt'], { cwd: repo, env }).status, 0);
      assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'c1'], { cwd: repo, env }).status, 0);
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8', env }).stdout.trim();
      const push = spawnSync(dest, [], {
        input: `refs/heads/main ${head} refs/heads/main 0000000000000000000000000000000000000000\n`,
        encoding: 'utf-8', env, cwd: repo,
      });
      assert.equal(push.status, 0, push.stderr);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('idempotent — second run keeps a working hook', () => {
  const tmp = freshDir('idem');
  try {
    const { repo, env } = makeRepo(tmp);
    assert.equal(spawnSync(process.execPath, [SCRIPT], { cwd: repo, env }).status, 0);
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf-8', env });
    assert.equal(r.status, 0, r.stderr);
    const dest = join(repo, '.git', 'hooks', 'pre-push');
    assert.ok(existsSync(dest));
    assert.ok(dest.startsWith && readFileSync(dest, 'utf-8').includes('pre-push.mjs'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('missing source exits 1', () => {
  const tmp = freshDir('missing');
  try {
    const { repo, env } = makeRepo(tmp);
    // Point the installer at a fake scripts dir with no pre-push.mjs by running
    // a copy whose sibling git-hooks/ lacks the source.
    const fakeDir = join(tmp, 'fake-scripts'); mkdirSync(fakeDir);
    mkdirSync(join(fakeDir, 'git-hooks'));
    const fakeScript = join(fakeDir, 'install-git-hooks.mjs');
    writeFileSync(fakeScript, readFileSync(SCRIPT));
    chmodSync(fakeScript, 0o755);
    const r = spawnSync(process.execPath, [fakeScript], { cwd: repo, encoding: 'utf-8', env });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('source hook not found'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});