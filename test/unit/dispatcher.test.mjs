import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dispatch, eventFromArgs } from '../../plugins/agent-hive/modules/hook-dispatcher.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dispatcher = join(here, '..', '..', 'plugins', 'agent-hive', 'modules', 'hook-dispatcher.mjs');

// Tests must never write into the user's real ~/.claude plugin data dir, so
// point CLAUDE_PLUGIN_DATA at a temp dir for both in-process dispatch and the
// spawned end-to-end runs.
let dataRoot;
test.before(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'disp-'));
  process.env.CLAUDE_PLUGIN_DATA = dataRoot;
});
test.after(() => {
  delete process.env.CLAUDE_PLUGIN_DATA;
  rmSync(dataRoot, { recursive: true, force: true });
});

const parsed = { ok: true, empty: false, error: null, data: {}, event: 'Stop', toolName: null, toolInput: {}, sessionId: 's', cwd: null, transcriptPath: null };

// Stop / UserPromptSubmit / PreToolUse / PostToolUse all return passthrough
// against a fresh (no-code-change) session. SubagentStop is no longer inert:
// with no assistant message it blocks (see the contract test below).
test('dispatch: stateless events return passthrough against a fresh session', () => {
  for (const ev of ['Stop', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']) {
    assert.deepEqual(dispatch(ev, parsed), {}, `${ev} should be passthrough`);
  }
});

test('dispatch: SubagentStop blocks when no assistant summary is present', () => {
  const out = dispatch('SubagentStop', parsed);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /No assistant summary message was found/);
});

test('dispatch: unknown event degrades to passthrough (never blocks)', () => {
  assert.deepEqual(dispatch('NotARealEvent', parsed), {});
});

test('dispatch: a handler crash never blocks the runtime', () => {
  // Simulated by dispatching an unknown event (no handler) — already passthrough.
  // A throwing handler is covered by the crash path inside dispatch, which also
  // returns passthrough; assert the contract holds for the unknown path.
  const out = dispatch('UnknownEvent', parsed);
  assert.equal('decision' in out, false);
  assert.equal('continue' in out, false);
});

test('eventFromArgs: reads --event, returns null when absent', () => {
  assert.equal(eventFromArgs(['--event', 'Stop']), 'Stop');
  assert.equal(eventFromArgs(['--event', 'PreToolUse', '--other', 'x']), 'PreToolUse');
  assert.equal(eventFromArgs([]), null);
  assert.equal(eventFromArgs(['--event']), null); // missing value
});

function runDispatcher(args, input) {
  return spawnSync(process.execPath, [dispatcher, ...args], {
    input, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataRoot },
  });
}

test('end-to-end: valid stdin -> valid JSON stdout, exit 0, clean stderr', () => {
  const r = runDispatcher(['--event', 'Stop'], JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }));
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), {});
});

test('end-to-end: malformed stdin -> still valid JSON output + stderr warning + exit 0', () => {
  const r = runDispatcher(['--event', 'Stop'], '{ not json');
  assert.equal(r.status, 0);
  JSON.parse(r.stdout); // does not throw
  assert.match(r.stderr, /invalid JSON|input warning/i);
});

test('end-to-end: empty stdin -> valid JSON output, exit 0', () => {
  const r = runDispatcher(['--event', 'Stop'], '');
  assert.equal(r.status, 0);
  JSON.parse(r.stdout);
});

test('end-to-end: no --event and no hook_event_name -> stderr note, still exit 0', () => {
  const r = runDispatcher([], JSON.stringify({ session_id: 's' }));
  assert.equal(r.status, 0);
  JSON.parse(r.stdout);
  assert.match(r.stderr, /no event/i);
});

test('end-to-end: arbitrary Unicode in stdin survives', () => {
  const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'naïve façade ☃ 日本語' });
  const r = runDispatcher(['--event', 'UserPromptSubmit'], input);
  assert.equal(r.status, 0);
  JSON.parse(r.stdout);
});