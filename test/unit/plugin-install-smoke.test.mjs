// Unit tests for scripts/plugin-install-smoke.mjs
//
// Exercises packagePlugin() and validatePackagedPlugin() against the real
// plugins/agnthive/ source: package to a mkdtempSync temp dir,
// validate, assert ok=true; then assert a planted stray .sh in the packaged
// dir makes ok=false; assert a broken manifest reference is flagged.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { packagePlugin, validatePackagedPlugin } from '../../scripts/plugin-install-smoke.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLUGIN_SRC = join(REPO_ROOT, 'plugins', 'agnthive');

function freshTemp() {
  return mkdtempSync(join(tmpdir(), 'plugin-install-smoke-test-'));
}

test('packagePlugin + validatePackagedPlugin pass on the real plugin source', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    // The packaged plugin lives at tmp/<basename(src)>.
    assert.equal(join(tmp, 'agnthive'), pluginDir);
    assert.ok(existsSync(join(pluginDir, '.claude-plugin', 'plugin.json')));
    assert.ok(existsSync(join(pluginDir, 'hooks', 'hooks.json')));
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, true, `expected ok, got errors:\n${r.errors.join('\n')}`);
    assert.equal(r.errors.length, 0);
    assert.ok(r.checks.length >= 5, `expected several checks, got ${r.checks.length}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a planted stray .sh in the packaged dir makes ok=false', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    writeFileSync(join(pluginDir, 'legacy.sh'), '#!/bin/bash\necho nope\n');
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('legacy.sh') && e.includes('Node-only')),
      `expected a legacy.sh offense, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a planted stray .py in the packaged dir makes ok=false', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    writeFileSync(join(pluginDir, 'helper.py'), 'print(1)\n');
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('helper.py') && e.includes('Node-only')),
      `expected a helper.py offense, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a broken manifest hooks reference is flagged', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSyncText(manifestPath));
    manifest.hooks = './hooks/does-not-exist.json';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('hooks path does not resolve') && e.includes('does-not-exist.json')),
      `expected a broken hooks-reference error, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a missing required manifest field is flagged', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSyncText(manifestPath));
    delete manifest.version;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('missing required field: version')),
      `expected a missing-version error, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a malformed userConfig entry is flagged', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSyncText(manifestPath));
    manifest.userConfig = { bad_key: { type: 'string' } }; // missing title/description/default
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('userConfig.bad_key') && e.includes('missing required field')),
      `expected a userConfig error, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a hook entry regressed to a shell-string command is flagged', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    const hooksPath = join(pluginDir, 'hooks', 'hooks.json');
    const hooks = JSON.parse(readFileSyncText(hooksPath));
    // Corrupt the first SessionStart hook into a shell-string command.
    hooks.hooks.SessionStart[0].hooks[0].command = 'node ./modules/hook-dispatcher.mjs --event SessionStart';
    delete hooks.hooks.SessionStart[0].hooks[0].args;
    writeFileSync(hooksPath, JSON.stringify(hooks, null, 2));
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('command must be "node"') || e.includes('shell string')),
      `expected an exec-form error, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a broken hooks.json ${CLAUDE_PLUGIN_ROOT} target is flagged', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    const hooksPath = join(pluginDir, 'hooks', 'hooks.json');
    const hooks = JSON.parse(readFileSyncText(hooksPath));
    hooks.hooks.SessionStart[0].hooks[0].args = [
      '${CLAUDE_PLUGIN_ROOT}/modules/missing.mjs',
      '--event',
      'SessionStart',
    ];
    writeFileSync(hooksPath, JSON.stringify(hooks, null, 2));
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('referenced path does not resolve') && e.includes('missing.mjs')),
      `expected a missing-target error, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a statusline helper with a syntax error is flagged', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    writeFileSync(join(pluginDir, 'scripts', 'statusline.mjs'), 'import { broken from "node:path"\n');
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('statusline.mjs failed to parse')),
      `expected a statusline parse error, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('an empty conventional directory is flagged', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    const agentsDir = join(pluginDir, 'agents');
    rmSync(agentsDir, { recursive: true, force: true });
    mkdirSync(agentsDir, { recursive: true });
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('agents/') && e.includes('empty')),
      `expected an empty-agents error, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a userConfig number key with a non-numeric default is flagged (strict schema)', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSyncText(manifestPath));
    manifest.userConfig = { bad_num: { type: 'number', title: 'x', description: 'x', default: 'not-a-number' } };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('userConfig.bad_num') && e.includes('default does not match its type number')),
      `expected a default/type mismatch error, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a userConfig key with an unsupported type is flagged (strict schema)', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSyncText(manifestPath));
    manifest.userConfig = { weird: { type: 'map', title: 'x', description: 'x', default: '' } };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('userConfig.weird') && e.includes('unsupported type: map')),
      `expected an unsupported-type error, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a subagent-statusline.mjs with a syntax error is flagged', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    writeFileSync(join(pluginDir, 'scripts', 'subagent-statusline.mjs'), 'const x = { ;\n');
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('subagent-statusline.mjs failed to parse')),
      `expected a subagent-statusline parse error, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a plugin settings.json with an unsupported (main-session) key is flagged', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    writeFileSync(
      join(pluginDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo nope' } }, null, 2),
    );
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('settings.json') && e.includes('unsupported key') && e.includes('statusLine')),
      `expected a settings.json unsupported-key error, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a plugin settings.json with a supported key still passes', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    // The real plugin already ships a subagentStatusLine-only settings.json;
    // re-assert the check passes and reports the key.
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, true, `expected ok, got errors:\n${r.errors.join('\n')}`);
    assert.ok(
      r.checks.some((c) => c.includes('settings.json uses only supported keys') && c.includes('subagentStatusLine')),
      `expected a settings.json ok check, got:\n${r.checks.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Helper — read a file as utf-8 text (kept at the bottom for readability of
// the test bodies above; ESM imports are hoisted regardless).
function readFileSyncText(p) {
  return readFileSync(p, 'utf-8');
}