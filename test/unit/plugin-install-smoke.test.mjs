// Unit tests for scripts/plugin-install-smoke.mjs
//
// Exercises packagePlugin() and validatePackagedPlugin() against the real
// plugins/agnthive/ source: package to a mkdtempSync temp dir,
// validate, assert ok=true; then assert a planted stray .sh in the packaged
// dir makes ok=false; assert a broken manifest reference is flagged.
//
// Also covers the manifest shape contract (docs/compatibility.md:
// defaultEnabled:false, no `requirements` key, userConfig contract keys) and
// the opt-in official-CLI tier (probeClaudeVersion / runOfficialStrictValidation
// / runCliTier) via cross-platform node-based fake CLIs; main()'s
// missing-CLI-hard-fail behavior is exercised through a subprocess (POSIX
// only, guarded below, because the fake binary needs an executable shebang).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  packagePlugin,
  validatePackagedPlugin,
  probeClaudeVersion,
  runOfficialStrictValidation,
  runCliTier,
} from '../../scripts/plugin-install-smoke.mjs';

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

test('manifest defaultEnabled must be exactly false (compatibility contract)', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSyncText(manifestPath));
    manifest.defaultEnabled = true;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('defaultEnabled') && e.includes('exactly')),
      `expected a defaultEnabled contract error, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('manifest defaultEnabled must not be removable (compatibility contract)', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSyncText(manifestPath));
    delete manifest.defaultEnabled;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('defaultEnabled') && e.includes('must be present')),
      `expected a defaultEnabled presence error, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('an invented requirements manifest key is flagged (ADR 0012)', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSyncText(manifestPath));
    manifest.requirements = ['claude-code>=2.1.295'];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('requirements') && e.includes('docs/compatibility.md')),
      `expected a requirements-key error, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a missing userConfig contract key is flagged', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSyncText(manifestPath));
    delete manifest.userConfig.log_max_bytes;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('userConfig missing contract key') && e.includes('log_max_bytes')),
      `expected a userConfig contract-key error, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a missing userConfig entirely is flagged', () => {
  const tmp = freshTemp();
  try {
    const pluginDir = packagePlugin(PLUGIN_SRC, tmp);
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSyncText(manifestPath));
    delete manifest.userConfig;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const r = validatePackagedPlugin(pluginDir);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('manifest userConfig missing')),
      `expected a userConfig-missing error, got:\n${r.errors.join('\n')}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- official CLI tier ----------

// Write a cross-platform fake claude CLI (a node script) into tmpDir and
// return an argv prefix that executes it on every OS: [process.execPath, script].
function writeFakeClaude(tmpDir, { version = '9.9.9', validateExit = 0, validateOutput = 'Fake validation passed' } = {}) {
  const scriptPath = join(tmpDir, `fake-claude-${Math.random().toString(36).slice(2)}.mjs`);
  const body = [
    `const args = process.argv.slice(2);`,
    `if (args.includes('--version')) { console.log('${version} (Fake Claude)'); process.exit(0); }`,
    `if (args[0] === 'plugin') { console.log('${validateOutput}'); process.exit(${validateExit}); }`,
    `process.exit(1);`,
  ].join('\n');
  writeFileSync(scriptPath, body);
  return [process.execPath, scriptPath];
}

test('probeClaudeVersion parses the leading semver from a fake CLI', () => {
  const tmp = freshTemp();
  try {
    const prefix = writeFakeClaude(tmp);
    const probe = probeClaudeVersion(prefix);
    assert.equal(probe.ok, true, `expected ok, got: ${probe.reason}`);
    assert.equal(probe.version, '9.9.9');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('probeClaudeVersion rejects unparsable --version output', () => {
  const tmp = freshTemp();
  try {
    const prefix = writeFakeClaude(tmp, { version: 'garbage' });
    const probe = probeClaudeVersion(prefix);
    assert.equal(probe.ok, false);
    assert.match(probe.reason, /unparsable --version output/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('probeClaudeVersion marks a missing executable as unavailable (never a crash)', () => {
  const probe = probeClaudeVersion(['/nonexistent/claude-definitely-not-here']);
  assert.equal(probe.ok, false);
  assert.match(probe.reason, /spawn failed/);
});

test('runOfficialStrictValidation reports exit 0 as ok and non-zero as failure with output', () => {
  const tmp = freshTemp();
  try {
    const goodFake = writeFakeClaude(tmp, { validateOutput: 'ok-validation-passed' });
    const good = runOfficialStrictValidation(goodFake, join(tmp, 'target-dir-pass'));
    assert.equal(good.ok, true, `expected ok, got: ${good.reason}`);
    assert.equal(good.exitCode, 0);

    const badFake = writeFakeClaude(tmp, { validateOutput: 'unknown field', validateExit: 1 });
    const bad = runOfficialStrictValidation(badFake, join(tmp, 'target-dir-fail'));
    assert.equal(bad.ok, false);
    assert.equal(bad.exitCode, 1);
    assert.match(bad.reason, /strict validation failed/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('runCliTier runs all three strict targets and enforces an expected version', () => {
  const tmp = freshTemp();
  try {
    const prefix = writeFakeClaude(tmp, { version: '9.9.9' });
    const tier = runCliTier(prefix, join(tmp, 'fake-plugin-root'), { expectedVersion: '9.9.9' });
    assert.equal(tier.ok, true, `expected ok; mismatch=${tier.mismatch}; reasons=${tier.results.map((x) => x.reason).join(' | ')}`);
    assert.equal(tier.results.length, 3);
    assert.ok(tier.results.every((x) => x.ok && x.label));
    assert.equal(tier.version, '9.9.9');

    const mismatched = runCliTier(prefix, join(tmp, 'fake-plugin-root'), { expectedVersion: '2.1.303' });
    assert.equal(mismatched.ok, false);
    assert.match(mismatched.mismatch, /version mismatch/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// main() subprocess checks. The fake CLI must be a directly executable file
// (shebang + chmod +x), which is not portable on Windows: these cases are
// POSIX-only by construction; the cross-platform logic above is already
// covered through argv prefixes. POSIX includes macOS (darwin).
const POSIX = process.platform !== 'win32';

// Absolute path of the smoke script for main() subprocess tests.
const SMOKE_SCRIPT = fileURLToPath(new URL('../../scripts/plugin-install-smoke.mjs', import.meta.url));

// Executable variant for main() subprocess tests (needs shebang + chmod +x,
// hence POSIX-only); mirrors writeFakeClaude()'s behavior exactly.
function writeExecutableFakeClaude(tmpDir, { version = '9.9.9' } = {}) {
  const scriptPath = join(tmpDir, `fake-claude-exe-${Math.random().toString(36).slice(2)}.js`);
  const body = [
    '#!/usr/bin/env node',
    `if (process.argv.slice(2).includes('--version')) { console.log('${version} (Fake Claude)'); process.exit(0); }`,
    `if (process.argv[2] === 'plugin') { console.log('Fake validation passed'); process.exit(0); }`,
    'process.exit(1);',
  ].join('\n') + '\n';
  writeFileSync(scriptPath, body);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

if (POSIX) {
  test('main(): missing CLI fails (not skips) in CI mode', () => {
    const tmp = freshTemp();
    try {
      const r = spawnSync(process.execPath, [SMOKE_SCRIPT, '--cli'], {
        encoding: 'utf-8',
        env: { ...process.env, CI: 'true', AGNTHIVE_CLAUDE_BIN: '/nonexistent/claude-nope' },
      });
      assert.equal(r.status, 1);
      assert.match(`${r.stdout}${r.stderr}`, /infrastructure failure/);
      assert.match(`${r.stdout}${r.stderr}`, /plugin-install-smoke: FAIL/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('main(): without --cli a missing CLI does not fail the structural smoke', () => {
    const tmp = freshTemp();
    try {
      const r = spawnSync(process.execPath, [SMOKE_SCRIPT], {
        encoding: 'utf-8',
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', AGNTHIVE_CLAUDE_BIN: '/nonexistent/claude-nope' },
      });
      assert.equal(r.status, 0);
      // No CLI tier without --cli: nothing CLI-related is attempted at all,
      // so the structural smoke still passes and no skip note is needed.
      assert.match(`${r.stdout}${r.stderr}`, /plugin-install-smoke: PASS \(16 checks\)/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('main(): --cli runs the real strict tier via a fake CLI and passes', () => {
    const tmp = freshTemp();
    try {
      const exe = writeExecutableFakeClaude(tmp, { version: '9.9.9' });
      const r = spawnSync(process.execPath, [SMOKE_SCRIPT, '--cli', '--cli-version', '9.9.9'], {
        encoding: 'utf-8',
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', AGNTHIVE_CLAUDE_BIN: exe },
      });
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /official strict validation \(manifest \(plugin root\)\) — claude plugin validate --strict exit 0/);
    } catch (e) {
      throw new Error(`subprocess test failed: ${e.message}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

// Helper — read a file as utf-8 text (kept at the bottom for readability of
// the test bodies above; ESM imports are hoisted regardless).
function readFileSyncText(p) {
  return readFileSync(p, 'utf-8');
}
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
