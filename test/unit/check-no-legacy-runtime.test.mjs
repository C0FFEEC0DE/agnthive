// Tests for scripts/check-no-legacy-runtime.mjs
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkNoLegacyRuntime, SCRIPTS_ALLOWLIST } from '../../scripts/check-no-legacy-runtime.mjs';
import { tmpdir } from 'node:os';

function makeTree(root) {
  // Clean Node-only plugin runtime + a Node script under scripts/ (no .py).
  mkdirSync(join(root, 'plugins', 'agent-hive', 'scripts'), { recursive: true });
  writeFileSync(join(root, 'plugins', 'agent-hive', 'scripts', 'statusline.mjs'), '// node\n');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'lint.mjs'), '// node\n');
}

function freshRoot() {
  const root = join(tmpdir(), `legacy-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

test('passes on a clean Node-only tree (no allowlisted .py runners)', () => {
  const root = freshRoot();
  try {
    makeTree(root);
    const r = checkNoLegacyRuntime(root);
    assert.equal(r.ok, true);
    assert.equal(r.offenses.length, 0);
    assert.deepEqual(r.allowlisted, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when a stray .sh is placed under plugins/', () => {
  const root = freshRoot();
  try {
    makeTree(root);
    writeFileSync(join(root, 'plugins', 'agent-hive', 'legacy.sh'), '#!/bin/bash\nexit 0\n');
    const r = checkNoLegacyRuntime(root);
    assert.equal(r.ok, false);
    assert.ok(r.offenses.some((o) => o.includes('legacy.sh') && o.includes('plugin runtime')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when a stray .py appears under plugins/', () => {
  const root = freshRoot();
  try {
    makeTree(root);
    writeFileSync(join(root, 'plugins', 'agent-hive', 'helper.py'), 'print(1)\n');
    const r = checkNoLegacyRuntime(root);
    assert.equal(r.ok, false);
    assert.ok(r.offenses.some((o) => o.includes('helper.py')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when any .py appears in scripts/ (allowlist is empty)', () => {
  const root = freshRoot();
  try {
    makeTree(root);
    // The former allowlisted runner is now an offense — all bench runners were
    // ported to Node ESM, so scripts/** must be Node-only.
    writeFileSync(join(root, 'scripts', 'bench_runner_claude_code.py'), '# ci runner\n');
    const r = checkNoLegacyRuntime(root);
    assert.equal(r.ok, false);
    assert.ok(r.offenses.some((o) => o.includes('bench_runner_claude_code.py') && o.includes('non-allowlisted')));
    assert.deepEqual(r.allowlisted, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when a non-allowlisted .sh appears in scripts/', () => {
  const root = freshRoot();
  try {
    makeTree(root);
    writeFileSync(join(root, 'scripts', 'stray.sh'), '#!/bin/bash\nexit 0\n');
    const r = checkNoLegacyRuntime(root);
    assert.equal(r.ok, false);
    assert.ok(r.offenses.some((o) => o.includes('stray.sh')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a .py nested in a subdir is an offense (allowlist matches the full relative path)', () => {
  const root = freshRoot();
  try {
    makeTree(root);
    mkdirSync(join(root, 'scripts', 'sub'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'sub', 'bench_runner_claude_code.py'), '# spoof\n');
    const r = checkNoLegacyRuntime(root);
    assert.equal(r.ok, false);
    assert.ok(r.offenses.some((o) => o.includes('scripts/sub/bench_runner_claude_code.py')));
    assert.deepEqual(r.allowlisted, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SCRIPTS_ALLOWLIST is empty (all bench runners ported to Node ESM)', () => {
  assert.equal(SCRIPTS_ALLOWLIST.length, 0);
});

test('missing plugins dir is not an error (empty offenses for plugin scan)', () => {
  const root = freshRoot();
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'lint.mjs'), '// node\n');
    const r = checkNoLegacyRuntime(root);
    assert.equal(r.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});