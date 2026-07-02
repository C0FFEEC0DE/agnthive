import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveLogRoot } from '../../plugins/agent-hive/modules/util.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dispatcher = join(root, 'plugins', 'agent-hive', 'modules', 'hook-dispatcher.mjs');

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

// --- PostCompact: ledger re-injection -------------------------------------

test('PostCompact: logs a marker and re-injects the durable progress ledger', () => {
  const proj = mkdtempSync(join(tmpdir(), 'proj-ledger-'));
  try {
    // Provide a ledger via the explicit override env so the test is hermetic.
    const ledgerFile = join(proj, 'progress.md');
    writeFileSync(ledgerFile, '- [x] task one\n- [x] task two\n');
    const res = run('PostCompact', { session_id: 'poc1', trigger: 'manual' }, dataRoot, { CLAUDE_CREW_PROGRESS_FILE: ledgerFile, CLAUDE_PROJECT_DIR: proj });
    assert.equal(res.status, 0, res.stderr);
    // Marker logged.
    const lines = readJsonl(dataRoot, 'post-compact.jsonl');
    assert.equal(lines[0].trigger, 'manual');
    // Ledger re-injected as additionalContext.
    const msg = ctx(res);
    assert.ok(msg, 'expected ledger context injection');
    assert.match(msg, /durable progress ledger follows/);
    assert.match(msg, /- \[x\] task one/);
    assert.match(msg, /- \[x\] task two/);
    assert.ok(!msg.includes('Ledger truncated'));
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

test('PostCompact: no ledger -> marker logged, no context injection (passthrough)', () => {
  const proj = mkdtempSync(join(tmpdir(), 'proj-noledger-'));
  try {
    const res = run('PostCompact', { session_id: 'poc2', trigger: 'manual' }, dataRoot, { CLAUDE_PROJECT_DIR: proj });
    assert.equal(res.status, 0);
    const lines = readJsonl(dataRoot, 'post-compact.jsonl');
    assert.equal(lines[lines.length - 1].session_id, 'poc2'); // this run's marker
    assert.deepEqual(JSON.parse(res.stdout), {}); // no context when no ledger
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

test('PostCompact: oversized multibyte ledger is UTF-8-safe truncated with a note', () => {
  const proj = mkdtempSync(join(tmpdir(), 'proj-bigledger-'));
  try {
    const ledgerFile = join(proj, 'progress.md');
    const line = '✔ completed task item with a longer description\n';
    writeFileSync(ledgerFile, line.repeat(40));
    const res = run('PostCompact', { session_id: 'poc3', trigger: 'manual' }, dataRoot, {
      CLAUDE_CREW_PROGRESS_FILE: ledgerFile, CLAUDE_CREW_LEDGER_MAX_BYTES: '64', CLAUDE_PROJECT_DIR: proj,
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = ctx(res);
    assert.ok(msg);
    assert.match(msg, /Ledger truncated: \d+ bytes exceeds 64 byte limit/);
    // No replacement char from a split multibyte sequence in the injected text.
    assert.ok(!msg.includes('�'), 'injection must not contain a split-sequence replacement char');
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

// --- rotation across the whole lifecycle ----------------------------------

test('rotation: a stream crossing the byte cap rolls to .old mid-lifecycle', () => {
  const stream = 'notification.jsonl';
  const lr = resolveLogRoot({ CLAUDE_PLUGIN_DATA: dataRoot });
  const f = join(lr, stream);
  // Pre-create a file at the cap so the next append rotates it.
  writeFileSync(f, 'x'.repeat(1024));
  run('Notification', { session_id: 'rot', title: 't', message: 'm' }, dataRoot, { CLAUDE_CREW_LOG_MAX_BYTES: '1024' });
  assert.ok(existsSync(`${f}.old`), '.old sidecar created by rotation');
  const fresh = readFileSync(f, 'utf8').trim();
  assert.ok(fresh.includes('"title":"t"'), 'fresh file holds only the new record');
});