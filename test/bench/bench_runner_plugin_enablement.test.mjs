// Tests for the plugin session enablement layer in
// scripts/bench_runner_claude_code.mjs (task_0002).
//
// Two runtime defects are covered here:
//   1. The plugin manifest ships "defaultEnabled": false, so a
//      `claude --plugin-dir <dir>` session LOADS the plugin but does not
//      ENABLE it: the host registers zero hooks from it and the plugin's Node
//      hook runtime never runs (measured on CLI 2.1.303: "Registered 0 hooks
//      from 3 plugins"). The fix is an explicit --settings file whose
//      enabledPlugins map carries the INLINE plugin id ("<name>@inline").
//   2. The host writes the session store to
//      ~/.claude/plugins/data/<name>-inline/<session-id>/ even when
//      CLAUDE_PLUGIN_DATA points elsewhere, so the runner must probe that
//      root (see bench_runner_plugin_evidence.test.mjs).
//
// Node standard library only; the injectable spawn seam is used so no real
// `claude` is ever spawned here.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  __setSpawnSync,
  inlinePluginId,
  pluginDisabledByEnv,
  pluginEnableSettings,
  removePluginEnableSettings,
  runClaude,
  writePluginEnableSettings,
} from '../../scripts/bench_runner_claude_code.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const REAL_PLUGIN_DIR = join(REPO, 'plugins', 'agnthive');

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'bench-enable-'));
}

// A minimal plugin dir with a real manifest, so the id derivation is exercised
// against a manifest rather than a hardcoded string.
function makePluginDir(tmp, name) {
  const dir = join(tmp, 'plugin');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '0.0.0', defaultEnabled: false }, null, 2),
  );
  return dir;
}

test('inlinePluginId: derived from the plugin manifest name + the inline sentinel', () => {
  const tmp = makeTempDir();
  try {
    const dir = makePluginDir(tmp, 'myplugin');
    assert.equal(inlinePluginId({ pluginDir: dir, env: {} }), 'myplugin@inline');
    // The repo's real plugin resolves to the measured inline id.
    assert.equal(inlinePluginId({ pluginDir: REAL_PLUGIN_DIR, env: {} }), 'agnthive@inline');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('inlinePluginId: BENCH_PLUGIN_ID overrides the derivation', () => {
  const tmp = makeTempDir();
  try {
    const dir = makePluginDir(tmp, 'myplugin');
    assert.equal(inlinePluginId({ pluginDir: dir, env: { BENCH_PLUGIN_ID: 'custom@inline' } }), 'custom@inline');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('inlinePluginId: an unreadable manifest falls back to the documented default', () => {
  const tmp = makeTempDir();
  try {
    // No manifest at all: the id must not silently become something else.
    assert.equal(inlinePluginId({ pluginDir: join(tmp, 'missing'), env: {} }), 'agnthive@inline');
    // An empty plugin dir must not read a cwd-relative file.
    assert.equal(inlinePluginId({ pluginDir: '', env: {} }), 'agnthive@inline');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('pluginEnableSettings: the payload enables the inline plugin id', () => {
  const settings = pluginEnableSettings('agnthive@inline');
  assert.deepEqual(settings, { enabledPlugins: { 'agnthive@inline': true } });
});

test('pluginDisabledByEnv: only the documented truthy values disable the plugin', () => {
  assert.equal(pluginDisabledByEnv({ BENCH_DISABLE_PLUGIN: '1' }), true);
  assert.equal(pluginDisabledByEnv({ BENCH_DISABLE_PLUGIN: 'true' }), true);
  assert.equal(pluginDisabledByEnv({ BENCH_DISABLE_PLUGIN: 'YES' }), true);
  assert.equal(pluginDisabledByEnv({ BENCH_DISABLE_PLUGIN: 'on' }), true);
  assert.equal(pluginDisabledByEnv({ BENCH_DISABLE_PLUGIN: '0' }), false);
  assert.equal(pluginDisabledByEnv({ BENCH_DISABLE_PLUGIN: '' }), false);
  assert.equal(pluginDisabledByEnv({}), false);
});

test('writePluginEnableSettings: writes the enabling payload and removePluginEnableSettings deletes it', () => {
  const tmp = makeTempDir();
  try {
    const path = writePluginEnableSettings({ outputDir: tmp, pluginId: 'agnthive@inline' });
    assert.ok(path, 'settings file path returned');
    assert.ok(existsSync(path), 'settings file written');
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    assert.deepEqual(parsed, { enabledPlugins: { 'agnthive@inline': true } });
    assert.equal(removePluginEnableSettings(path), true);
    assert.equal(existsSync(path), false, 'settings file removed');
    // Removing a missing file is not an error.
    assert.equal(removePluginEnableSettings(path), false);
    assert.equal(removePluginEnableSettings(''), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('runClaude: the child argv carries --settings with a file that enables the plugin', () => {
  const tmp = makeTempDir();
  try {
    const outputDir = join(tmp, 'out');
    mkdirSync(outputDir, { recursive: true });
    const calls = [];
    let settingsContentAtSpawn = null;
    let settingsPathAtSpawn = '';
    __setSpawnSync((bin, args, opts) => {
      calls.push({ bin, args: [...args], opts });
      // Read the settings file WHILE the child would see it (it is removed
      // once the spawn returns).
      settingsPathAtSpawn = args[args.indexOf('--settings') + 1] || '';
      if (settingsPathAtSpawn && existsSync(settingsPathAtSpawn)) {
        settingsContentAtSpawn = readFileSync(settingsPathAtSpawn, 'utf-8');
      }
      return { status: 0, stdout: '{}', stderr: '' };
    });
    try {
      runClaude('prompt', join(tmp, 'debug.log'), join(tmp, 'stderr.log'), {}, {
        claudeBin: 'claude', modelName: 'm', pluginDir: REAL_PLUGIN_DIR, workdir: tmp,
        timeoutSeconds: 5, outputDir,
      });
    } finally {
      __setSpawnSync(null);
    }
    assert.equal(calls.length, 1);
    const args = calls[0].args;
    assert.ok(args.includes('--plugin-dir'), 'plugin dir passed');
    assert.ok(args.includes('--settings'), 'settings flag passed');
    const settingsPath = args[args.indexOf('--settings') + 1];
    assert.ok(settingsPath, 'settings path present');
    // The file existed at spawn time and enabled the INLINE plugin id.
    assert.ok(settingsContentAtSpawn, 'the settings file existed at spawn time');
    assert.deepEqual(
      JSON.parse(settingsContentAtSpawn),
      { enabledPlugins: { 'agnthive@inline': true } },
    );
    // ... and it is cleaned up afterwards (a session artifact, not a durable one).
    assert.equal(existsSync(settingsPath), false, 'settings file removed after the run');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('runClaude: BENCH_DISABLE_PLUGIN=1 removes --plugin-dir and --settings from the child argv', () => {
  const tmp = makeTempDir();
  const prev = process.env.BENCH_DISABLE_PLUGIN;
  try {
    process.env.BENCH_DISABLE_PLUGIN = '1';
    const calls = [];
    __setSpawnSync((bin, args, opts) => {
      calls.push({ bin, args: [...args], opts });
      return { status: 0, stdout: '{}', stderr: '' };
    });
    try {
      runClaude('prompt', join(tmp, 'debug.log'), join(tmp, 'stderr.log'), {}, {
        claudeBin: 'claude', modelName: 'm', pluginDir: REAL_PLUGIN_DIR, workdir: tmp,
        timeoutSeconds: 5, outputDir: tmp,
      });
    } finally {
      __setSpawnSync(null);
    }
    assert.equal(calls.length, 1);
    const args = calls[0].args;
    assert.equal(args.includes('--plugin-dir'), false, 'no --plugin-dir in the native arm');
    assert.equal(args.includes('--settings'), false, 'no --settings in the native arm');
    // The rest of the invocation is unchanged.
    assert.ok(args.includes('--output-format'));
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  } finally {
    if (prev === undefined) delete process.env.BENCH_DISABLE_PLUGIN;
    else process.env.BENCH_DISABLE_PLUGIN = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('runClaude: the no-plugin path works with a missing plugin dir (no crash)', () => {
  const tmp = makeTempDir();
  const prev = process.env.BENCH_DISABLE_PLUGIN;
  try {
    process.env.BENCH_DISABLE_PLUGIN = '1';
    const calls = [];
    __setSpawnSync((bin, args, opts) => {
      calls.push({ bin, args: [...args], opts });
      return { status: 0, stdout: '{}', stderr: '' };
    });
    try {
      const [status] = runClaude('prompt', join(tmp, 'debug.log'), join(tmp, 'stderr.log'), {}, {
        claudeBin: 'claude', modelName: 'm', pluginDir: join(tmp, 'no-such-plugin-dir'),
        workdir: tmp, timeoutSeconds: 5, outputDir: tmp,
      });
      assert.equal(status, 0);
    } finally {
      __setSpawnSync(null);
    }
    assert.equal(calls.length, 1, 'the child was still spawned');
    assert.equal(calls[0].args.includes('--plugin-dir'), false);
  } finally {
    if (prev === undefined) delete process.env.BENCH_DISABLE_PLUGIN;
    else process.env.BENCH_DISABLE_PLUGIN = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('runClaude: the settings file is removed even when the child times out', () => {
  const tmp = makeTempDir();
  try {
    const outputDir = join(tmp, 'out');
    mkdirSync(outputDir, { recursive: true });
    let seenSettingsPath = '';
    __setSpawnSync((bin, args) => {
      seenSettingsPath = args[args.indexOf('--settings') + 1] || '';
      return {
        error: Object.assign(new Error('spawnSync claude ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        signal: 'SIGTERM',
        status: null,
        stdout: '',
        stderr: '',
      };
    });
    try {
      assert.throws(
        () => runClaude('prompt', join(tmp, 'debug.log'), join(tmp, 'stderr.log'), {}, {
          claudeBin: 'claude', modelName: 'm', pluginDir: REAL_PLUGIN_DIR, workdir: tmp,
          timeoutSeconds: 5, outputDir,
        }),
        (err) => err.name === 'TimeoutExpired',
      );
    } finally {
      __setSpawnSync(null);
    }
    assert.ok(seenSettingsPath, 'the settings file was passed to the child');
    assert.equal(existsSync(seenSettingsPath), false, 'settings file removed on the error path');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('runClaude: AGNTHIVE_WORKFLOW_PROFILE from the runner env reaches the child env', () => {
  const tmp = makeTempDir();
  const prev = process.env.AGNTHIVE_WORKFLOW_PROFILE;
  try {
    process.env.AGNTHIVE_WORKFLOW_PROFILE = 'lean';
    const calls = [];
    __setSpawnSync((bin, args, opts) => {
      calls.push({ bin, args: [...args], opts });
      return { status: 0, stdout: '{}', stderr: '' };
    });
    try {
      runClaude('prompt', join(tmp, 'debug.log'), join(tmp, 'stderr.log'), {}, {
        claudeBin: 'claude', modelName: 'm', pluginDir: REAL_PLUGIN_DIR, workdir: tmp,
        timeoutSeconds: 5, outputDir: tmp,
      });
    } finally {
      __setSpawnSync(null);
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.env.AGNTHIVE_WORKFLOW_PROFILE, 'lean');
  } finally {
    if (prev === undefined) delete process.env.AGNTHIVE_WORKFLOW_PROFILE;
    else process.env.AGNTHIVE_WORKFLOW_PROFILE = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('runClaude: an unset workflow profile is not injected into the child env', () => {
  const tmp = makeTempDir();
  const prev = process.env.AGNTHIVE_WORKFLOW_PROFILE;
  try {
    delete process.env.AGNTHIVE_WORKFLOW_PROFILE;
    const calls = [];
    __setSpawnSync((bin, args, opts) => {
      calls.push({ bin, args: [...args], opts });
      return { status: 0, stdout: '{}', stderr: '' };
    });
    try {
      runClaude('prompt', join(tmp, 'debug.log'), join(tmp, 'stderr.log'), {}, {
        claudeBin: 'claude', modelName: 'm', pluginDir: REAL_PLUGIN_DIR, workdir: tmp,
        timeoutSeconds: 5, outputDir: tmp,
      });
    } finally {
      __setSpawnSync(null);
    }
    assert.equal(calls[0].opts.env.AGNTHIVE_WORKFLOW_PROFILE, undefined);
  } finally {
    if (prev !== undefined) process.env.AGNTHIVE_WORKFLOW_PROFILE = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('runClaude: the per-run evidence index (CLAUDE_PLUGIN_DATA) is still passed to the child', () => {
  const tmp = makeTempDir();
  try {
    const outputDir = join(tmp, 'out');
    mkdirSync(outputDir, { recursive: true });
    const calls = [];
    __setSpawnSync((bin, args, opts) => {
      calls.push({ bin, args: [...args], opts });
      return { status: 0, stdout: '{}', stderr: '' };
    });
    try {
      runClaude('prompt', join(tmp, 'debug.log'), join(tmp, 'stderr.log'), {}, {
        claudeBin: 'claude', modelName: 'm', pluginDir: REAL_PLUGIN_DIR, workdir: tmp,
        timeoutSeconds: 5, outputDir,
      });
    } finally {
      __setSpawnSync(null);
    }
    assert.equal(calls[0].opts.env.CLAUDE_PLUGIN_DATA, join(outputDir, 'plugin-data'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
