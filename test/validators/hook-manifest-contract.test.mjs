// Validator-side contract tests for the landed plugin hook manifest
// (plugins/agnthive/hooks/hooks.json), the plugin userConfig surface, and the
// slash-command inventory, driven through the exported pure validators in
// scripts/validate.mjs (structure validated over a deep clone of the LANDED
// manifest, so the fixtures cannot stale-drift from the source of truth).
//
// Rules (one negative fixture per rule, each asserting an error-message
// snippet; see brief w3-validators / plan task 13 + F09):
//   1 unknown hooks.json top-level key
//   2 unknown host/dispatcher hook event (StopFailure must be accepted)
//   3 hook record shape: nested {matcher, hooks}, unknown record field
//   4 unknown command-hook field (typo'd key "timeouts")
//   5 exec form + single Node dispatcher routing (+ --event consistency)
//   6 timeout policy (10s sync / 30s async, positive finite number)
//   7 onFailure vocabulary block|warn|disable
//   8 onFailure:"block" reserved for PreToolUse shell policy
//   9 PreToolUse Bash/PowerShell parity
//  10 userConfig unknown key
//  11 userConfig missing contract key
//  12 enforcement_mode advisory|enforce
//  13 byte-cap userConfig defaults (positive finite numbers)
//  14 workflow_profile is a required contract key (legacy|lean, default legacy)
//  15 slash-command inventory: agent-backed set is exactly ['review']
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateHookManifestStructure,
  validateUserConfigShape,
  collectSlashCommandInventoryErrors,
  AGENT_BACKED_SKILLS,
  SLASH_COMMAND_NAMES,
  KNOWN_HOOK_EVENTS,
  USER_CONFIG_CONTRACT_KEYS,
  WORKFLOW_PROFILE_VALUES,
} from '../../scripts/validate.mjs';

// The landed manifests are the fixture source of truth.
const REPO = join(import.meta.dirname, '..', '..');
const HOOKS_JSON = JSON.parse(readFileSync(join(REPO, 'plugins', 'agnthive', 'hooks', 'hooks.json'), 'utf-8'));
const PLUGIN_JSON = JSON.parse(readFileSync(join(REPO, 'plugins', 'agnthive', '.claude-plugin', 'plugin.json'), 'utf-8'));

const clone = () => structuredClone(HOOKS_JSON);
const ucClone = () => structuredClone(PLUGIN_JSON.userConfig);

/** mutate(manifest) must produce an error containing `snippet`. */
function expectSnippet(mutate, snippet) {
  const m = clone();
  mutate(m);
  const errors = validateHookManifestStructure(m);
  assert.ok(
    errors.some((e) => e.includes(snippet)),
    `expected an error containing ${JSON.stringify(snippet)}, got: ${JSON.stringify(errors)}`,
  );
}

test('landed hooks.json passes the structural hook validator', () => {
  assert.deepEqual(validateHookManifestStructure(HOOKS_JSON), []);
});

test('landed plugin userConfig passes the userConfig validator', () => {
  assert.deepEqual(validateUserConfigShape(PLUGIN_JSON.userConfig), []);
});

test('workflow_profile is a required contract key with legacy|lean domain', () => {
  assert.ok(USER_CONFIG_CONTRACT_KEYS.includes('workflow_profile'));
  assert.ok(WORKFLOW_PROFILE_VALUES.has('legacy') && WORKFLOW_PROFILE_VALUES.has('lean'));
  // The landed manifest ships default "legacy" (task 11), and `lean` stays an
  // accepted in-domain value.
  assert.equal(PLUGIN_JSON.userConfig.workflow_profile.default, 'legacy');
  const uc = ucClone();
  uc.workflow_profile.default = 'lean';
  assert.deepEqual(validateUserConfigShape(uc), []);
});

test('StopFailure is a known event registered async with timeout 30', () => {
  assert.ok(KNOWN_HOOK_EVENTS.has('StopFailure'));
  const recs = HOOKS_JSON.hooks.StopFailure;
  assert.ok(Array.isArray(recs) && recs.length > 0);
  const hd = recs[0].hooks[0];
  assert.equal(recs[0].matcher, '*');
  assert.equal(hd.async, true);
  assert.equal(hd.timeout, 30);
  assert.ok(recs[0].hooks[0].args.includes('--event') && hd.args[hd.args.indexOf('--event') + 1] === 'StopFailure');
});

// ---- rule 1: unknown hooks.json top-level key ----
test('negative: unknown top-level key fails', () => {
  expectSnippet(
    (m) => { m.hookss = {}; },
    'unsupported top-level key',
  );
});

// ---- rule 2: unknown host/dispatcher event ----
test('negative: unknown hook event fails (typo drift off StopFailure)', () => {
  expectSnippet(
    (m) => {
      m.hooks.StopFailures = m.hooks.StopFailure; delete m.hooks.StopFailure;
      m.hooks.StopFailures[0].hooks[0].args[3] = 'StopFailures';
    },
    "unknown hook event 'StopFailures'",
  );
});

// ---- rule 3: hook record shape / unknown record field ----
test('negative: unknown hook record field fails', () => {
  expectSnippet(
    (m) => { m.hooks.Stop[0].hook = []; },
    'unknown hook record field(s): hook',
  );
});

// ---- rule 4: unknown command-hook field, typo'd key "timeouts" ----
test('negative: typo-d key "timeouts" fails as unknown command hook field', () => {
  expectSnippet(
    (m) => { m.hooks.PreToolUse[0].hooks[0].timeouts = 10; },
    'unknown command hook field(s): timeouts',
  );
});

// ---- rule 5: exec form + single dispatcher routing ----
test('negative: command not riding the single dispatcher fails', () => {
  expectSnippet(
    (m) => { m.hooks.Stop[0].hooks[0].args = ['${CLAUDE_PLUGIN_ROOT}/modules/other.mjs', '--event', 'Stop']; },
    'must route to the single Node dispatcher',
  );
});

test('negative: non-node command fails exec form', () => {
  expectSnippet(
    (m) => {
      m.hooks.Stop[0].hooks[0].command = 'sh';
      m.hooks.Stop[0].hooks[0].args = ['-c', 'echo hi'];
      m.hooks.Stop[0].hooks[0].onFailure = 'block';
    },
    'hook command must be "node"',
  );
});

// ---- rule 6: timeout policy ----
test('negative: sync registration with timeout 99 fails', () => {
  expectSnippet((m) => { m.hooks.UserPromptSubmit[0].hooks[0].timeout = 99; }, 'synchronous registration must declare timeout: 10');
});

test('negative: async registration with timeout 10 fails', () => {
  expectSnippet((m) => { m.hooks.StopFailure[0].hooks[0].timeout = 10; }, 'asynchronous registration (async: true) must declare timeout: 30');
});

test('negative: missing timeout fails', () => {
  expectSnippet((m) => { delete m.hooks.PreToolUse[0].hooks[0].timeout; }, "missing required 'timeout'");
});

test('negative: non-numeric timeout fails', () => {
  expectSnippet((m) => { m.hooks.Stop[0].hooks[0].timeout = '10'; }, "'timeout' must be a positive finite number");
});

// ---- rule 7: onFailure vocabulary ----
test('negative: onFailure "maybe" fails', () => {
  expectSnippet(
    (m) => { m.hooks.Notification[0].hooks[0].onFailure = 'maybe'; },
    'must be one of block|warn|disable',
  );
});

// ---- rule 8: block placement reserved for the shell policy ----
test('negative: onFailure block outside PreToolUse fails', () => {
  expectSnippet(
    (m) => { m.hooks.Notification[0].hooks[0].onFailure = 'block'; },
    'allowed only on the shared PreToolUse shell-policy',
  );
});

// ---- rule 9: PreToolUse Bash/PowerShell parity ----
test('negative: missing PowerShell shell-policy registration fails', () => {
  expectSnippet(
    (m) => { m.hooks.PreToolUse = m.hooks.PreToolUse.filter((r) => r.matcher !== 'PowerShell'); },
    'PowerShell',
  );
});

test('negative: PowerShell record without onFailure block fails', () => {
  expectSnippet(
    (m) => {
      const rec = m.hooks.PreToolUse.find((r) => r.matcher === 'PowerShell');
      rec.hooks[0].onFailure = 'warn';
    },
    "PreToolUse 'PowerShell' shell-policy registration must carry onFailure:",
  );
});

// ---- rule 10: userConfig unknown key ----
test('negative: unknown userConfig key fails', () => {
  const uc = ucClone();
  uc.log_max_size = { type: 'number', title: 'x', description: 'y', default: 1024 };
  const errors = validateUserConfigShape(uc);
  assert.ok(
    errors.some((e) => e.includes('unknown userConfig key(s): log_max_size')),
    JSON.stringify(errors),
  );
});

// ---- rule 11: missing userConfig contract key ----
test('negative: missing userConfig contract key fails', () => {
  const uc = ucClone();
  delete uc.ledger_max_bytes;
  const errors = validateUserConfigShape(uc);
  assert.ok(errors.some((e) => e.includes('ledger_max_bytes')), JSON.stringify(errors));
});

// ---- rule 12: enforcement_mode domain ----
test('negative: enforcement_mode default outside advisory|enforce fails', () => {
  const uc = ucClone();
  uc.enforcement_mode.default = 'yolo';
  const errors = validateUserConfigShape(uc);
  assert.ok(errors.some((e) => e.includes('advisory|enforce')), JSON.stringify(errors));
});

// ---- rule 13: byte-cap defaults ----
test('negative: non-numeric log_max_bytes default fails', () => {
  const uc = ucClone();
  uc.log_max_bytes.default = '1 MiB';
  const errors = validateUserConfigShape(uc);
  assert.ok(errors.some((e) => e.includes('positive finite byte threshold')), JSON.stringify(errors));
});

// ---- rule 13b: workflow_profile is no longer merely tolerated ----
test('negative: typo-d workflow_profile key and out-of-domain value fail', () => {
  const uc = ucClone();
  delete uc.workflow_profile;
  uc.workflow_profil = { type: 'string', title: 'x', description: 'y', default: 'legacy' };
  const errors = validateUserConfigShape(uc);
  assert.ok(errors.some((e) => e.includes('unknown userConfig key(s): workflow_profil')), JSON.stringify(errors));
  assert.ok(errors.some((e) => e.includes("missing contract key(s): workflow_profile")), JSON.stringify(errors));
  const bad = ucClone();
  bad.workflow_profile.default = 'yolo';
  const badErrors = validateUserConfigShape(bad);
  assert.ok(badErrors.some((e) => e.includes('legacy|lean')), JSON.stringify(badErrors));
});

// ---- rule 14: slash-command inventory (agent-backed set) ----
test('agent-backed skill set in the repo is exactly review', () => {
  // Independent repo read (no shared helper): dirs whose SKILL.md
  // declares `agent:`.
  const skillsDir = join(REPO, 'plugins', 'agnthive', 'skills');
  const dirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  const agentBacked = dirs.filter((n) => {
    if (!statSync(join(skillsDir, n, 'SKILL.md')).isFile()) return false;
    const text = readFileSync(join(skillsDir, n, 'SKILL.md'), 'utf-8');
    const fm = text.split('---')[1] ?? '';
    return fm.split('\n').some((l) => l.startsWith('agent:'));
  });
  assert.deepEqual(agentBacked.sort(), ['review']);
});

test('validator expects exactly the review agent-backed skill set', () => {
  assert.deepEqual(AGENT_BACKED_SKILLS, ['review']);
  assert.deepEqual(SLASH_COMMAND_NAMES.length, 9);
  assert.ok(SLASH_COMMAND_NAMES.includes('review'));
  assert.ok(USER_CONFIG_CONTRACT_KEYS.includes('enforcement_mode'));
});

test('repo passes the exported slash-command inventory collector', () => {
  const { checks, errors } = collectSlashCommandInventoryErrors();
  assert.deepEqual(errors, []);
  assert.ok(checks.includes('plugin agent-backed skill inventory'), JSON.stringify(checks));
});
