import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveLogRoot } from '../../plugins/agnthive/modules/util.mjs';
import {
  statePaths, ensureStateDir, appendEvent, loadState,
} from '../../plugins/agnthive/modules/state.mjs';
import { buildSessionStartRestore } from '../../plugins/agnthive/modules/ledger.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dispatcher = join(root, 'plugins', 'agnthive', 'modules', 'hook-dispatcher.mjs');

function run(event, stdin, dataRoot, env = {}) {
  return spawnSync(process.execPath, [dispatcher, '--event', event], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataRoot, ...env },
    cwd: root,
  });
}

function readJsonl(dataRoot, name) {
  const f = join(resolveLogRoot({ CLAUDE_PLUGIN_DATA: dataRoot }), name);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

let dataRoot;
test.before(() => { dataRoot = mkdtempSync(join(tmpdir(), 'life-')); });
test.after(() => { rmSync(dataRoot, { recursive: true, force: true }); });

function ctx(res) { return JSON.parse(res.stdout).hookSpecificOutput?.additionalContext ?? null; }

// --- SessionStart ---------------------------------------------------------

test('SessionStart: detects npm test/lint/build and emits profile-active context', () => {
  // The repo root has package.json scripts test/lint/build? Use a temp project
  // with a package.json defining those scripts so detection is deterministic.
  const proj = mkdtempSync(join(tmpdir(), 'proj-'));
  try {
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ scripts: { test: 'pytest -q', lint: 'ruff .', build: 'tsc' } }));
    const res = run('SessionStart', { session_id: 'ss1', cwd: proj }, dataRoot, { CLAUDE_PROJECT_DIR: proj });
    assert.equal(res.status, 0, res.stderr);
    const msg = ctx(res);
    assert.ok(msg);
    assert.match(msg, /Hook-gated SDLC is active/);
    assert.match(msg, /test=npm run test/);
    assert.match(msg, /lint=npm run lint/);
    assert.match(msg, /build=npm run build/);
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

test('SessionStart: no detected commands omits the Detected commands suffix', () => {
  const proj = mkdtempSync(join(tmpdir(), 'proj-empty-'));
  try {
    const res = run('SessionStart', { session_id: 'ss2', cwd: proj }, dataRoot, { CLAUDE_PROJECT_DIR: proj });
    assert.equal(res.status, 0);
    const msg = ctx(res);
    assert.match(msg, /Hook-gated SDLC is active/);
    assert.ok(!msg.includes('Detected commands'), msg);
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

// --- Notification ---------------------------------------------------------

test('Notification: logs payload to notification.jsonl and passes through', () => {
  const res = run('Notification', { session_id: 'n1', title: 'Build done', message: 'All green', subtype: 'success', context: 'ci' }, dataRoot);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {}); // passthrough, no decision/context
  const lines = readJsonl(dataRoot, 'notification.jsonl');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].title, 'Build done');
  assert.equal(lines[0].message, 'All green');
  assert.equal(lines[0].session_id, 'n1');
  // F10/ADR-0013: the record carries the current notification_type field
  // (bridged from the legacy subtype input alias); subtype itself is gone.
  assert.equal(lines[0].notification_type, 'success');
  assert.ok(!('subtype' in lines[0]), 'subtype replaced by notification_type');
  assert.match(lines[0].ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('Notification: logs shell-metachar payload verbatim and safely (no injection)', () => {
  run('Notification', { session_id: 'n2', title: 'Hello "World"', message: 'Test; rm -rf /' }, dataRoot);
  const f = join(resolveLogRoot({ CLAUDE_PLUGIN_DATA: dataRoot }), 'notification.jsonl');
  const raw = readFileSync(f, 'utf8');
  assert.ok(raw.includes('"title":"Hello \\"World\\""'));
  assert.ok(raw.includes('"message":"Test; rm -rf /"'));
});

// --- InstructionsLoaded / ConfigChange ------------------------------------

test('InstructionsLoaded: audits to instructions-loaded.jsonl', () => {
  const res = run('InstructionsLoaded', { session_id: 'il1', file_path: 'CLAUDE.md', memory_type: 'project', load_reason: 'session_start' }, dataRoot);
  assert.equal(res.status, 0);
  const lines = readJsonl(dataRoot, 'instructions-loaded.jsonl');
  assert.equal(lines[0].load_reason, 'session_start');
  assert.equal(lines[0].file_path, 'CLAUDE.md');
});

test('ConfigChange: audits to config-change.jsonl', () => {
  const res = run('ConfigChange', { session_id: 'cc1', source: 'user_settings', file_path: '~/.claude/settings.json' }, dataRoot);
  assert.equal(res.status, 0);
  const lines = readJsonl(dataRoot, 'config-change.jsonl');
  assert.equal(lines[0].source, 'user_settings');
  assert.equal(lines[0].file_path, '~/.claude/settings.json');
});

// --- PreCompact / SessionEnd (state snapshots) ----------------------------

test('PreCompact: records a marker with a state snapshot', () => {
  const res = run('PreCompact', { session_id: 'pc1', trigger: 'manual' }, dataRoot);
  assert.equal(res.status, 0);
  const lines = readJsonl(dataRoot, 'pre-compact.jsonl');
  assert.equal(lines[0].trigger, 'manual');
  assert.ok(lines[0].state && typeof lines[0].state === 'object');
});

test('SessionEnd: records the session index with cwd/transcript/reason + state', () => {
  const res = run('SessionEnd', { session_id: 'se1', cwd: '/repo', transcript_path: '/t.jsonl', reason: 'normal' }, dataRoot);
  assert.equal(res.status, 0);
  const lines = readJsonl(dataRoot, 'session-index.jsonl');
  assert.equal(lines[0].session_id, 'se1');
  assert.equal(lines[0].cwd, '/repo');
  assert.equal(lines[0].transcript_path, '/t.jsonl');
  assert.equal(lines[0].reason, 'normal');
  assert.ok(lines[0].state && typeof lines[0].state === 'object');
});

// --- PostCompact: bounded bookkeeping (ADR-0013, plan 07.2/07.5) ----------

test('PostCompact: logs a bounded bookkeeping marker (metadata/size/status only)', () => {
  const proj = mkdtempSync(join(tmpdir(), 'proj-ledger-'));
  try {
    // Provide a ledger via the explicit override env so the test is hermetic.
    const ledgerFile = join(proj, 'progress.md');
    writeFileSync(ledgerFile, '- [x] task one\n- [x] task two\n');
    const res = run('PostCompact', { session_id: 'poc1', trigger: 'manual' }, dataRoot, { AGNTHIVE_PROGRESS_FILE: ledgerFile, CLAUDE_PROJECT_DIR: proj });
    assert.equal(res.status, 0, res.stderr);
    // Marker logged; the default record is metadata/size/status only.
    const lines = readJsonl(dataRoot, 'post-compact.jsonl');
    const last = lines[lines.length - 1];
    assert.equal(last.trigger, 'manual');
    assert.equal(last.compact_summary_present, false);
    assert.equal(last.compact_summary_bytes, 0);
    assert.ok(!('compact_summary' in last), 'default PostCompact record stores no summary text');
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

test('PostCompact: provided summary content is not stored by default', () => {
  const proj = mkdtempSync(join(tmpdir(), 'proj-sumlog-'));
  try {
    const res = run('PostCompact', { session_id: 'poc2', trigger: 'manual', compact_summary: 'SECRET HOST SUMMARY' }, dataRoot, { CLAUDE_PROJECT_DIR: proj });
    assert.equal(res.status, 0);
    const lines = readJsonl(dataRoot, 'post-compact.jsonl');
    const last = lines[lines.length - 1];
    assert.equal(last.session_id, 'poc2'); // this run's marker
    assert.equal(last.compact_summary_present, true);
    assert.equal(last.compact_summary_bytes, 19);
    assert.ok(!('compact_summary' in last), 'no summary text without the verbose opt-in');
    assert.ok(
      !readFileSync(join(resolveLogRoot({ CLAUDE_PLUGIN_DATA: dataRoot }), 'post-compact.jsonl'), 'utf8').includes('SECRET HOST SUMMARY'),
    );
    // stdout contract (deprecated injection vs plain passthrough) is the
    // orchestrator's task-07 wiring; here stdout only stays one JSON object.
    assert.ok(typeof JSON.parse(res.stdout) === 'object');
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

// --- SessionStart compact/resume restore (ADR-0013, plan 07.1/07.3) --------
// The dispatcher-side source gate (inject only for source=compact/resume) and
// the restored_task_seq event append are the orchestrator's task-07 wiring and
// are asserted in test/unit/dispatcher.test.mjs. This section covers the
// ledger/state contract end-to-end through the real modules, so the behavior
// is pinned before the wiring lands.

test('SessionStart restore: real state store bookkeeping dedupes a repeated cycle', () => {
  const dataRoot2 = mkdtempSync(join(tmpdir(), 'life-restore-'));
  try {
    const sid = 'restore-dedupe-1';
    const paths = statePaths(dataRoot2, sid);
    ensureStateDir(paths);
    // Open a task (what the lifecycle owner's writer will produce), then run
    // the restore contract twice for the SAME restoration cycle token with the
    // state between the two calls reflecting the applied patch.
    appendEvent(paths, 'set_many', {
      fields: {
        revision: 3,
        restored_task_seq: 0,
        active_task: {
          id: 'T-9', kind: 'feature', status: 'open', revision: 1,
          required_subagents: [], required_subagent_any_of: [],
          dispatch_contract_mode: '', docs_required: false,
        },
      },
    });
    const leadState1 = loadState(paths);
    assert.ok(leadState1.active_task && leadState1.active_task.id === 'T-9');
    const r1 = buildSessionStartRestore(leadState1, { projectDir: dataRoot2, ledgerPath: join(dataRoot2, 'absent.md') });
    assert.ok(r1, 'first cycle restores (missing ledger -> diagnostic)');
    assert.equal(r1.patch.restored_task_seq, 1);
    appendEvent(paths, 'set_many', { fields: r1.patch });
    const leadState2 = loadState(paths);
    assert.equal(leadState2.restored_task_seq, 1);
    // Same cycle token again -> dedupe hit, no second injection.
    const r2 = buildSessionStartRestore(leadState2, { projectDir: dataRoot2, ledgerPath: join(dataRoot2, 'absent.md'), cycleSeq: 1 });
    assert.equal(r2, null);
    // A new restoration cycle (token 2) restores again.
    const r3 = buildSessionStartRestore(leadState2, { projectDir: dataRoot2, ledgerPath: join(dataRoot2, 'absent.md'), cycleSeq: 2 });
    assert.ok(r3, 'a later restoration cycle restores again');
    assert.equal(r3.patch.restored_task_seq, 2);
    assert.ok(r3.message.includes('T-9'));
  } finally { rmSync(dataRoot2, { recursive: true, force: true }); }
});

test('SessionStart restore: builder diagnostic carries the explicit ledger location', () => {
  const proj = mkdtempSync(join(tmpdir(), 'life-restore-loc-'));
  try {
    const ledgerFile = join(proj, '.agnthive', 'progress.md');
    mkdirSync(join(proj, '.agnthive'), { recursive: true });
    writeFileSync(ledgerFile, '- [x] completed entry one\n');
    const state = { revision: 2, task_type: 'feature', active_task: { id: 'T-5', kind: 'feature', status: 'open', revision: 2 } };
    const r = buildSessionStartRestore(state, { projectDir: proj });
    assert.ok(r, 'default path resolution through projectDir');
    assert.equal(r.ledger.path, ledgerFile);
    assert.equal(r.ledger.status, 'present');
    assert.ok(r.message.includes(ledgerFile), 'explicit ledger location reference');
    assert.ok(r.message.includes('T-5'), r.message);
    assert.ok(!r.message.includes('completed entry one'), 'ledger content is not injected');
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

// --- rotation across the whole lifecycle ----------------------------------

test('rotation: a stream crossing the byte cap rolls to .old mid-lifecycle', () => {
  const stream = 'notification.jsonl';
  const lr = resolveLogRoot({ CLAUDE_PLUGIN_DATA: dataRoot });
  const f = join(lr, stream);
  // Pre-create a file at the cap so the next append rotates it.
  writeFileSync(f, 'x'.repeat(1024));
  run('Notification', { session_id: 'rot', title: 't', message: 'm' }, dataRoot, { AGNTHIVE_LOG_MAX_BYTES: '1024' });
  assert.ok(existsSync(`${f}.old`), '.old sidecar created by rotation');
  const fresh = readFileSync(f, 'utf8').trim();
  assert.ok(fresh.includes('"title":"t"'), 'fresh file holds only the new record');
});