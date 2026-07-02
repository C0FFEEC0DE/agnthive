// Tests the durable progress-ledger re-injection on PostCompact via the
// plugin's Node hook dispatcher (plugins/agent-hive/modules/
// hook-dispatcher.mjs). Ported from the legacy shell-based
// tests/test_progress_ledger.py, which exercised the removed
// claudecfg/hooks/post-compact.sh. The ledger is re-injected as
// additionalContext when non-empty; the compact event is also logged to
// post-compact.jsonl under the plugin data root.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const REPO = join(import.meta.dirname, '..', '..');
const PLUGIN = join(REPO, 'plugins', 'agent-hive');
const DISPATCHER = join(PLUGIN, 'modules', 'hook-dispatcher.mjs');

function freshDir(label) {
  const d = join(tmpdir(), `pl-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

// Build the per-spawn env mirroring scripts/test-hooks.mjs: a hermetic HOME,
// CLAUDE_PLUGIN_ROOT + CLAUDE_PLUGIN_DATA pointed at the temp home, and
// CLAUDE_PROJECT_DIR set to the temp project dir. CLAUDE_CREW_PROGRESS_FILE
// pinpoints the ledger (existing or absent) so the dispatcher's
// progressLedgerPath resolves deterministically regardless of cwd.
function baseEnv(tmp, ledgerFile) {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: join(tmp, 'home'),
    CLAUDE_PLUGIN_ROOT: PLUGIN,
    CLAUDE_PLUGIN_DATA: join(tmp, 'home', '.claude'),
    CLAUDE_PROJECT_DIR: tmp,
  };
  delete env.CLAUDE_CREW_LEDGER_MAX_BYTES;
  env.CLAUDE_CREW_PROGRESS_FILE = ledgerFile ?? join(tmp, 'absent.md');
  return env;
}

// Spawn the plugin dispatcher with an explicit argv (no shell). The dispatcher
// reads one JSON object from stdin and writes one JSON object to stdout.
function runDispatcher(payload, env) {
  return spawnSync(process.execPath, [DISPATCHER, '--event', 'PostCompact'], {
    input: JSON.stringify(payload), encoding: 'utf-8', env, cwd: REPO,
  });
}

// Read the last non-empty JSON line from a JSONL log file.
function readLastJsonlLine(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  return JSON.parse(lines[lines.length - 1]);
}

test('injects ledger when present', () => {
  const tmp = freshDir('present');
  try {
    const ledger = join(tmp, 'progress.md');
    writeFileSync(ledger,
      'Task 1: complete (commits abc1234..def5678, review clean)\n' +
      'Task 2: complete (commits def5678..9abcdef0, review clean)\n');
    const r = runDispatcher({ session_id: 's-ledger', trigger: 'manual', compact_summary: '' }, baseEnv(tmp, ledger));
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const hso = out.hookSpecificOutput;
    assert.equal(hso.hookEventName, 'PostCompact');
    const ctx = hso.additionalContext;
    assert.ok(ctx.includes('Task 1: complete'));
    assert.ok(ctx.includes('abc1234..def5678'));
    assert.ok(ctx.includes('do not re-dispatch'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('no ledger emits nothing', () => {
  const tmp = freshDir('none');
  try {
    const r = runDispatcher({ session_id: 's-none', trigger: 'manual', compact_summary: '' }, baseEnv(tmp, null));
    assert.equal(r.status, 0, r.stderr);
    // The plugin's passthrough() serializes to an empty JSON object (no
    // additionalContext is injected when no ledger is present).
    assert.equal(r.stdout.trim(), '{}');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('whitespace-only ledger emits nothing', () => {
  const tmp = freshDir('ws');
  try {
    const ledger = join(tmp, 'progress.md');
    writeFileSync(ledger, '   \n\n  \t \n');
    const r = runDispatcher({ session_id: 's-empty', trigger: 'manual', compact_summary: '' }, baseEnv(tmp, ledger));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '{}');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('still logs the compact event to post-compact.jsonl', () => {
  const tmp = freshDir('log');
  try {
    const ledger = join(tmp, 'progress.md');
    writeFileSync(ledger, 'Task 1: complete\n');
    const env = baseEnv(tmp, ledger);
    const r = runDispatcher({ session_id: 's-log', trigger: 'manual', compact_summary: 'sum' }, env);
    assert.equal(r.status, 0, r.stderr);
    // The plugin writes telemetry under <CLAUDE_PLUGIN_DATA>/logs/ (not
    // ~/.claude/logs/ as the legacy shell hook did).
    const logFile = join(env.CLAUDE_PLUGIN_DATA, 'logs', 'post-compact.jsonl');
    assert.ok(existsSync(logFile), 'post-compact.jsonl audit log must be written');
    const last = readLastJsonlLine(logFile);
    assert.equal(last.session_id, 's-log');
    assert.equal(last.trigger, 'manual');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('truncates an oversized ledger (>64 KiB)', () => {
  const tmp = freshDir('trunc');
  try {
    const ledger = join(tmp, 'progress.md');
    const marker = 'TASK_START ';
    const filler = (marker + 'x\n').repeat(6000);
    const oversized = 'HEADER LINE\n' + filler;
    writeFileSync(ledger, oversized);
    const env = baseEnv(tmp, ledger);
    const r = runDispatcher({ session_id: 's-trunc', trigger: 'manual', compact_summary: '' }, env);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('HEADER LINE'));
    assert.ok(ctx.includes('Ledger truncated'));
    assert.ok(ctx.includes('exceeds 65536 byte limit'));
    assert.ok(Buffer.byteLength(ctx, 'utf-8') < Buffer.byteLength(oversized, 'utf-8'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});