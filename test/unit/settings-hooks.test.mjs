// Validates the plugin hook manifest (plugins/agent-hive/hooks/
// hooks.json) structure: every event uses exec form (command: "node" + args
// array) routing to a single Node dispatcher, with the nested {hooks:[...]}
// record format. This is the plugin successor to the legacy
// claudecfg/settings.json hook-structure test.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
const MANIFEST_PATH = join(REPO, 'plugins', 'agent-hive', 'hooks', 'hooks.json');
const DISPATCHER = '${CLAUDE_PLUGIN_ROOT}/modules/hook-dispatcher.mjs';

const HOOK_EVENTS = new Set([
  'SessionStart', 'InstructionsLoaded', 'UserPromptSubmit', 'PreToolUse',
  'PermissionRequest', 'PermissionDenied', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'Stop', 'TeammateIdle', 'TaskCompleted',
  'Notification', 'ConfigChange', 'PreCompact', 'PostCompact', 'SessionEnd',
]);

// Events that carry a real (non-"*") matcher in the plugin manifest. Every
// other event uses matcher: "*" (the plugin always sets a matcher field).
const MATCHER_EVENTS = new Set([
  'InstructionsLoaded', 'PreToolUse', 'PermissionRequest', 'PermissionDenied',
  'PostToolUse', 'PostToolUseFailure',
]);

const VALID_HOOK_RECORD_KEYS = new Set(['matcher', 'hooks']);
const VALID_COMMAND_HOOK_KEYS = new Set(['type', 'command', 'args', 'async']);

function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
}

function validateHookRecord(rec, event) {
  const errors = [];
  if (!('hooks' in rec)) errors.push(`${event}: missing required 'hooks' key - all events use nested format`);
  else if (!Array.isArray(rec.hooks)) errors.push(`${event}: 'hooks' must be an array`);
  else if (rec.hooks.length === 0) errors.push(`${event}: 'hooks' array must not be empty`);
  else {
    rec.hooks.forEach((hd, i) => {
      if (!hd || typeof hd !== 'object') { errors.push(`${event}.hooks[${i}]: must be an object`); return; }
      if (!('type' in hd)) errors.push(`${event}.hooks[${i}]: missing required 'type' key`);
      if (hd.type === 'command') {
        if (!('command' in hd)) errors.push(`${event}.hooks[${i}]: command hook missing required 'command' key`);
        if (!('args' in hd) || !Array.isArray(hd.args)) errors.push(`${event}.hooks[${i}]: command hook must use exec form (args array)`);
      }
      const invalid = Object.keys(hd).filter((k) => !VALID_COMMAND_HOOK_KEYS.has(k));
      if (invalid.length) errors.push(`${event}.hooks[${i}]: invalid keys in command hook: ${invalid}`);
    });
  }
  if (!('matcher' in rec)) errors.push(`${event}: every hook record must carry a matcher`);
  const invalidKeys = Object.keys(rec).filter((k) => !VALID_HOOK_RECORD_KEYS.has(k));
  if (invalidKeys.length) errors.push(`${event}: invalid keys in hook record: ${invalidKeys}`);
  return errors;
}

test('hooks manifest is valid JSON object', () => {
  const m = loadManifest();
  assert.equal(typeof m, 'object');
  assert.ok(m !== null);
});

test('hooks section exists and is an object', () => {
  const m = loadManifest();
  assert.ok('hooks' in m);
  assert.equal(typeof m.hooks, 'object');
});

test('all hook events are known types', () => {
  const events = new Set(Object.keys(loadManifest().hooks));
  const unknown = [...events].filter((e) => !HOOK_EVENTS.has(e));
  assert.deepEqual(unknown, []);
});

test('every hook event is a non-empty array', () => {
  const m = loadManifest();
  for (const [event, val] of Object.entries(m.hooks)) {
    assert.ok(Array.isArray(val), `${event}: must be an array`);
    assert.ok(val.length > 0, `${event}: array must not be empty`);
  }
});

test('all events use nested {hooks:[...]} format', () => {
  const m = loadManifest();
  for (const [event, arr] of Object.entries(m.hooks)) {
    arr.forEach((rec, i) => {
      assert.ok('hooks' in rec, `${event}[${i}]: missing 'hooks' key — ALL events must use nested format`);
      assert.ok(Array.isArray(rec.hooks), `${event}[${i}]: 'hooks' must be an array`);
    });
  }
});

test('every hook record carries a matcher', () => {
  const m = loadManifest();
  for (const [event, arr] of Object.entries(m.hooks)) {
    arr.forEach((rec, i) => {
      assert.ok('matcher' in rec, `${event}[${i}]: every hook record must carry a matcher`);
    });
  }
});

test('matcher-based events use a real (non-"*") matcher', () => {
  const m = loadManifest();
  for (const event of MATCHER_EVENTS) {
    if (!(event in m.hooks)) continue;
    m.hooks[event].forEach((rec, i) => {
      assert.ok('matcher' in rec, `${event}[${i}]: matcher-based event missing 'matcher' key`);
      assert.notEqual(rec.matcher, '*', `${event}[${i}]: matcher-based event must use a real matcher, not '*'`);
      assert.ok('hooks' in rec, `${event}[${i}]: matcher-based event missing 'hooks' key`);
      assert.ok(Array.isArray(rec.hooks), `${event}[${i}]: 'hooks' must be an array`);
    });
  }
});

test('PostToolUse tracks all file-write tools (Edit|MultiEdit|Write|NotebookEdit)', () => {
  const post = loadManifest().hooks.PostToolUse || [];
  const matchers = new Set(post.map((h) => h.matcher || ''));
  assert.ok(matchers.has('Edit|MultiEdit|Write|NotebookEdit'));
});

test('all command hooks use exec form routing to the single Node dispatcher', () => {
  const m = loadManifest();
  for (const [event, arr] of Object.entries(m.hooks)) {
    arr.forEach((rec, i) => {
      (rec.hooks || []).forEach((hd, ni) => {
        assert.equal(hd.type, 'command', `${event}[${i}].hooks[${ni}]: must be type 'command'`);
        assert.equal(hd.command, 'node', `${event}[${i}].hooks[${ni}]: command must be 'node' (exec form, no shell)`);
        assert.ok(Array.isArray(hd.args), `${event}[${i}].hooks[${ni}]: must have an args array (exec form)`);
        assert.ok(hd.args.includes(DISPATCHER), `${event}[${i}].hooks[${ni}]: args must route to the single hook dispatcher`);
      });
    });
  }
});

test('Notification hook uses the Node dispatcher and is async', () => {
  const notif = loadManifest().hooks.Notification || [];
  assert.ok(notif.length, 'Notification hook must be configured');
  const rec = notif[0];
  assert.equal(rec.matcher, '*', 'Notification hook uses the catch-all matcher');
  const nested = rec.hooks || [];
  assert.ok(nested.length, 'Notification hook must define nested hooks');
  const hd = nested[0];
  assert.equal(hd.type, 'command');
  assert.equal(hd.command, 'node');
  assert.ok(Array.isArray(hd.args) && hd.args.includes('--event') && hd.args.includes('Notification'),
    'Notification hook must route to the dispatcher with --event Notification');
  assert.equal(hd.async, true);
});

test('no invalid keys in hook records', () => {
  const m = loadManifest();
  for (const [event, arr] of Object.entries(m.hooks)) {
    arr.forEach((rec, i) => {
      const errors = validateHookRecord(rec, `${event}[${i}]`);
      assert.deepEqual(errors, [], `Validation errors: ${errors.join('; ')}`);
    });
  }
});

test('hook definitions have required type and command keys', () => {
  const m = loadManifest();
  for (const [event, arr] of Object.entries(m.hooks)) {
    arr.forEach((rec, i) => {
      const list = rec.hooks || [];
      list.forEach((hd, ni) => {
        assert.ok('type' in hd, `${event}[${i}].hooks[${ni}]: missing 'type' key`);
        if (hd.type === 'command') {
          assert.ok('command' in hd, `${event}[${i}].hooks[${ni}]: command hook missing 'command' key`);
          assert.ok('args' in hd, `${event}[${i}].hooks[${ni}]: command hook missing 'args' key (exec form)`);
        }
      });
    });
  }
});

test('regression: no flat format without hooks key', () => {
  const m = loadManifest();
  for (const [event, arr] of Object.entries(m.hooks)) {
    arr.forEach((rec, i) => {
      assert.ok('hooks' in rec, `${event}[${i}]: CRITICAL - missing 'hooks' key causes 'Invalid key in record'`);
    });
  }
});