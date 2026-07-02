// Node tests for scripts/collect-benchmark-changes.mjs (port of the Python test).
// Integration test: sets up a real git repo and runs the CLI via subprocess.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { collectChangedFiles } from '../../scripts/collect-benchmark-changes.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'collect-benchmark-changes.mjs');

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf-8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function setupGitIdentity(repo) {
  run('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  run('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
}

function writeFile(p, content) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content, 'utf-8');
}

function makeRepo(d) {
  const origin = join(d, 'origin.git');
  const worktree = join(d, 'worktree');
  run('git', ['init', '--bare', origin], { cwd: d });
  run('git', ['clone', origin, worktree], { cwd: d });
  setupGitIdentity(worktree);
  return { origin, worktree };
}

test('workflow_dispatch on feature branch collects diff vs base', () => {
  const d = join(tmpdir(), 'cbc-' + Date.now());
  mkdirSync(d, { recursive: true });
  const { origin, worktree } = makeRepo(d);

  run('git', ['switch', '-c', 'main'], { cwd: worktree });
  writeFile(join(worktree, 'README.md'), 'seed\n');
  run('git', ['add', 'README.md'], { cwd: worktree });
  run('git', ['commit', '-m', 'seed'], { cwd: worktree });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: worktree });

  run('git', ['switch', '-c', 'feature'], { cwd: worktree });
  writeFile(join(worktree, 'plugins/agent-hive/agents/manager.md'), 'changed\n');
  run('git', ['add', 'plugins/agent-hive/agents/manager.md'], { cwd: worktree });
  run('git', ['commit', '-m', 'feature change'], { cwd: worktree });

  const output = join(d, 'feature-changes.txt');
  const r = spawnSync(process.execPath, [SCRIPT,
    '--event', 'workflow_dispatch', '--output', output,
    '--base-ref', 'main', '--ref-name', 'feature',
  ], { cwd: worktree, encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(output, 'utf-8').split('\n').filter(Boolean), ['plugins/agent-hive/agents/manager.md']);
});

test('workflow_dispatch on main collects recent history', () => {
  const d = join(tmpdir(), 'cbc2-' + Date.now());
  mkdirSync(d, { recursive: true });
  const { origin, worktree } = makeRepo(d);

  run('git', ['switch', '-c', 'main'], { cwd: worktree });
  writeFile(join(worktree, 'README.md'), 'seed\n');
  run('git', ['add', 'README.md'], { cwd: worktree });
  run('git', ['commit', '-m', 'seed'], { cwd: worktree });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: worktree });

  writeFile(join(worktree, 'bench/fixtures/node-app/README.md'), 'recent change\n');
  run('git', ['add', 'bench/fixtures/node-app/README.md'], { cwd: worktree });
  run('git', ['commit', '-m', 'recent main change'], { cwd: worktree });

  const output = join(d, 'main-changes.txt');
  const r = spawnSync(process.execPath, [SCRIPT,
    '--event', 'workflow_dispatch', '--output', output,
    '--base-ref', 'main', '--ref-name', 'main',
  ], { cwd: worktree, encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(new Set(readFileSync(output, 'utf-8').split('\n').filter(Boolean)),
    new Set(['README.md', 'bench/fixtures/node-app/README.md']));
});

test('collectChangedFiles unit sortedUnique', () => {
  // Direct unit test of the export with a real repo (pull_request event).
  const d = join(tmpdir(), 'cbc3-' + Date.now());
  mkdirSync(d, { recursive: true });
  const { origin, worktree } = makeRepo(d);
  run('git', ['switch', '-c', 'main'], { cwd: worktree });
  writeFile(join(worktree, 'a.txt'), '1\n');
  run('git', ['add', 'a.txt'], { cwd: worktree });
  run('git', ['commit', '-m', 'init'], { cwd: worktree });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: worktree });
  run('git', ['switch', '-c', 'feat'], { cwd: worktree });
  writeFile(join(worktree, 'b.txt'), '2\n');
  run('git', ['add', 'b.txt'], { cwd: worktree });
  run('git', ['commit', '-m', 'add b'], { cwd: worktree });
  const files = collectChangedFiles('pull_request', 'main', '24', '', worktree);
  assert.deepEqual(files, ['b.txt']);
});