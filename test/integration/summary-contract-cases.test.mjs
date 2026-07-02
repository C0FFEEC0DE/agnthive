import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { statePaths, appendEvent, loadState } from '../../plugins/agent-hive/modules/state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dispatcher = join(root, 'plugins', 'agent-hive', 'modules', 'hook-dispatcher.mjs');
const fixtures = join(root, 'test', 'hooks', 'fixtures');
const cases = JSON.parse(readFileSync(join(root, 'test', 'hooks', 'cases.json'), 'utf8'));

// Map each bash handler script to the dispatcher event (+ matcher) that ports
// it. The Node dispatcher must produce output equivalent to the bash script for
// every case defined in cases.json for these five families.
const SCRIPT_TO_EVENT = {
  'claudecfg/hooks/stop-guard.sh': { event: 'Stop', matcher: null },
  'claudecfg/hooks/subagent-stop-guard.sh': { event: 'SubagentStop', matcher: null },
  'claudecfg/hooks/task-completed.sh': { event: 'TaskCompleted', matcher: null },
  'claudecfg/hooks/teammate-idle.sh': { event: 'TeammateIdle', matcher: null },
  'claudecfg/hooks/post-edit-write.sh': { event: 'PostToolUse', matcher: 'EditWrite' },
};

const TARGET_SCRIPTS = new Set(Object.keys(SCRIPT_TO_EVENT));
const relevant = cases.filter((c) => TARGET_SCRIPTS.has(c.script));

// jq is used to evaluate the exact same stdout_jq / state_jq expressions the
// bash harness uses, so the Node port is held to byte-equivalent assertions.
// (jq is a test-harness dependency, never a plugin-runtime dependency.)
function jqEval(expr, inputJson) {
  const r = spawnSync('jq', ['-e', expr], { input: inputJson ?? '', encoding: 'utf8' });
  return r.status === 0;
}

function runCase(c, dataRoot) {
  const stdin = readFileSync(join(root, c.stdin), 'utf8');
  const sid = JSON.parse(stdin).session_id || 'no-session';
  // Seed the Node append-only state store with the bash seed_state, if any.
  if (c.seed_state) {
    const seed = JSON.parse(readFileSync(join(root, c.seed_state), 'utf8'));
    appendEvent(statePaths(dataRoot, sid), 'set_many', { fields: seed });
  }
  const { event, matcher } = SCRIPT_TO_EVENT[c.script];
  const args = [dispatcher, '--event', event];
  if (matcher) args.push('--matcher', matcher);
  return spawnSync(process.execPath, args, {
    input: stdin, encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataRoot },
    cwd: root,
  });
}

// Drive every relevant case through the dispatcher and evaluate the case's
// own assertions. Each case gets an isolated data root so shared session_ids
// (e.g. "case-stop-guard") cannot collide across cases with different seeds.
for (const c of relevant) {
  test(`fixture: ${c.name} (${c.script.replace('claudecfg/hooks/', '')})`, () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'sc-case-'));
    try {
      const res = runCase(c, dataRoot);
      const expectExit = c.expect_exit ?? 0;
      assert.equal(res.status, expectExit,
        `exit ${res.status} !== ${expectExit}; stderr: ${res.stderr}`);

      if (c.stdout_jq) {
        const stdout = res.stdout.trim();
        assert.ok(stdout, 'expected stdout JSON but got empty output');
        assert.ok(JSON.parse(stdout), 'stdout is not valid JSON');
        assert.equal(jqEval(c.stdout_jq, stdout), true,
          `stdout_jq failed: ${c.stdout_jq}\nstdout: ${stdout}`);
      } else if (expectExit === 0) {
        // Cases without stdout_jq only assert exit 0 in the bash harness (the
        // case name may be aspirational — e.g. a "generic roles" case still
        // blocks on a missing assistant message). Just require valid JSON on
        // stdout so the dispatcher never emits garbage. Block-vs-allow parity
        // with bash is verified separately for the asserted cases.
        JSON.parse(res.stdout || '{}');
      }

      if (c.stderr_regex) {
        assert.match(res.stderr, new RegExp(c.stderr_regex),
          `stderr_regex failed: ${c.stderr_regex}\nstderr: ${res.stderr}`);
      } else if (expectExit === 2) {
        // A blocking exit 2 must carry a stderr explanation.
        assert.ok(res.stderr.trim(), 'expected a stderr message on exit 2');
      }

      if (c.state_jq) {
        const stdin = readFileSync(join(root, c.stdin), 'utf8');
        const sid = JSON.parse(stdin).session_id || 'no-session';
        const state = loadState(statePaths(dataRoot, sid));
        assert.equal(jqEval(c.state_jq, JSON.stringify(state)), true,
          `state_jq failed: ${c.state_jq}\nstate: ${JSON.stringify(state)}`);
      }
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
}

// --- explicit regression tests for the loop / terminal-cancellation edges ---

test('regression: repeated identical Stop block escalates to terminal hardStop', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sc-esc-'));
  try {
    const seed = JSON.parse(readFileSync(join(fixtures, 'state_stop_guard_repeated_review_block.json'), 'utf8'));
    const stdin = readFileSync(join(fixtures, 'stop_guard_missing_review.json'), 'utf8');
    appendEvent(statePaths(dataRoot, 'case-stop-guard'), 'set_many', { fields: seed });
    const res = spawnSync(process.execPath, [dispatcher, '--event', 'Stop'], {
      input: stdin, encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataRoot }, cwd: root,
    });
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout);
    assert.equal('decision' in out, false, 'hardStop must not carry decision:block');
    assert.equal(out.hardStop, true);
    assert.equal(out.continue, false);
    assert.match(out.stopReason, /Repeated stop-block loop detected/);
    const state = loadState(statePaths(dataRoot, 'case-stop-guard'));
    assert.equal(state.stalled_by_policy, true);
    assert.match(state.policy_stall_reason, /Repeated stop-block loop detected/);
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test('regression: after policy stall, Stop repeats only the terminal signal', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sc-stall-'));
  try {
    const seed = JSON.parse(readFileSync(join(fixtures, 'state_stop_guard_policy_stalled.json'), 'utf8'));
    const stdin = readFileSync(join(fixtures, 'stop_guard_missing_review.json'), 'utf8');
    appendEvent(statePaths(dataRoot, 'case-stop-guard'), 'set_many', { fields: seed });
    const res = spawnSync(process.execPath, [dispatcher, '--event', 'Stop'], {
      input: stdin, encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataRoot }, cwd: root,
    });
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout);
    assert.equal('decision' in out, false);
    assert.equal(out.hardStop, true);
    assert.equal(out.continue, false);
    assert.match(out.stopReason, /Repeated stop-block loop detected/);
    // The terminal path must NOT record a new loop block: count stays at 3.
    const state = loadState(statePaths(dataRoot, 'case-stop-guard'));
    assert.equal(state.stop_block_count, 3);
    assert.equal(state.stalled_by_policy, true);
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});
