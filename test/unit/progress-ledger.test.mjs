// Tests the progress-ledger contract across the compaction lifecycle through
// the plugin's Node hook dispatcher (plugins/agnthive/modules/
// hook-dispatcher.mjs). Ported from the legacy shell-based
// tests/test_progress_ledger.py, which exercised the removed
// claudecfg/hooks/post-compact.sh.
//
// ADR-0013 (plan task 07): the guaranteed restoration channel is SessionStart
// compact/resume via ledger.mjs buildSessionStartRestore (pure builder, covered
// by test/unit/ledger.test.mjs). PostCompact is BOUNDED BOOKKEEPING: it logs
// metadata (size/status only) to post-compact.jsonl and no longer promises
// context delivery through the unverified async output envelope. The SessionStart
// source gate + restored_task_seq event append are the orchestrator's dispatch
// wiring: the PostCompact stdout contract is therefore NOT asserted here —
// stdout is only checked to stay exactly one JSON object, so this suite holds
// under both the pre-wiring (deprecated injection) and post-wiring (plain
// bookkeeping) dispatcher shapes.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const REPO = join(import.meta.dirname, '..', '..');
const PLUGIN = join(REPO, 'plugins', 'agnthive');
const DISPATCHER = join(PLUGIN, 'modules', 'hook-dispatcher.mjs');

function freshDir(label) {
  const d = join(tmpdir(), `pl-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

// Build the per-spawn env mirroring scripts/test-hooks.mjs: a hermetic HOME,
// CLAUDE_PLUGIN_ROOT + CLAUDE_PLUGIN_DATA pointed at the temp home, and
// CLAUDE_PROJECT_DIR set to the temp project dir. AGNTHIVE_PROGRESS_FILE pinpoints
// the ledger (existing or absent) so the dispatcher's progressLedgerPath
// resolves deterministically regardless of cwd.
function baseEnv(tmp, ledgerFile) {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: join(tmp, 'home'),
    CLAUDE_PLUGIN_ROOT: PLUGIN,
    CLAUDE_PLUGIN_DATA: join(tmp, 'home', '.claude'),
    CLAUDE_PROJECT_DIR: tmp,
  };
  delete env.AGNTHIVE_LEDGER_MAX_BYTES;
  env.AGNTHIVE_PROGRESS_FILE = ledgerFile ?? join(tmp, 'absent.md');
  return env;
}

// Spawn the plugin dispatcher with an explicit argv (no shell). The dispatcher
// reads one JSON object from stdin and writes one JSON object to stdout.
function runDispatcher(payload, env, event = 'PostCompact') {
  return spawnSync(process.execPath, [DISPATCHER, '--event', event], {
    input: JSON.stringify(payload), encoding: 'utf-8', env, cwd: REPO,
  });
}

// Read the last non-empty JSON line from a JSONL log file.
function readLastJsonlLine(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  return JSON.parse(lines[lines.length - 1]);
}
// --- PostCompact: bounded bookkeeping telemetry (ADR-0013, plan 07.2/07.5) --

test('PostCompact: telemetry record is metadata/size/status only (no summary text)', () => {
  const tmp = freshDir('log-meta');
  try {
    const ledger = join(tmp, 'progress.md');
    writeFileSync(ledger, 'Task 1: complete (commits abc1234..def5678, review clean)\n');
    const env = baseEnv(tmp, ledger);
    const r = runDispatcher(
      { session_id: 's-meta', trigger: 'manual', compact_summary: 'SECRET COMPACT SUMMARY TEXT' },
      env,
    );
    assert.equal(r.status, 0, r.stderr);
    const logFile = join(env.CLAUDE_PLUGIN_DATA, 'logs', 'post-compact.jsonl');
    assert.ok(existsSync(logFile), 'post-compact.jsonl audit log must be written');
    const last = readLastJsonlLine(logFile);
    assert.equal(last.session_id, 's-meta');
    assert.equal(last.trigger, 'manual');
    assert.equal(last.compact_summary_present, true);
    assert.equal(last.compact_summary_bytes, 27);
    for (const key of Object.keys(last)) {
      assert.ok(
        ['ts', 'session_id', 'trigger', 'compact_summary_present', 'compact_summary_bytes'].includes(key),
        `unexpected key in the bound record: ${key}`,
      );
    }
    // The full compact summary (potentially sensitive content) is not in the
    // default telemetry record (F10/ADR-0013).
    assert.ok(!('compact_summary' in last), 'default record must not store summary text');
    assert.ok(!readFileSync(logFile, 'utf8').includes('SECRET COMPACT SUMMARY TEXT'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('PostCompact: absent summary -> present=false, bytes=0, still logged', () => {
  const tmp = freshDir('log-meta-none');
  try {
    const env = baseEnv(tmp, null);
    const r = runDispatcher({ session_id: 's-none', trigger: 'manual' }, env);
    assert.equal(r.status, 0, r.stderr);
    const logFile = join(env.CLAUDE_PLUGIN_DATA, 'logs', 'post-compact.jsonl');
    assert.ok(existsSync(logFile), 'post-compact.jsonl audit log must be written');
    const last = readLastJsonlLine(logFile);
    assert.equal(last.session_id, 's-none');
    assert.equal(last.compact_summary_present, false);
    assert.equal(last.compact_summary_bytes, 0);
    assert.ok(!('compact_summary' in last));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('PostCompact: stdout stays exactly one JSON object (wiring-agnostic)', () => {
  const tmp = freshDir('stdout-shape');
  try {
    const ledger = join(tmp, 'progress.md');
    writeFileSync(ledger, 'Task 1: complete\n');
    const r = runDispatcher({ session_id: 's-shape', trigger: 'manual' }, baseEnv(tmp, ledger));
    assert.equal(r.status, 0, r.stderr);
    // One JSON object; the injection vs passthrough decision is the
    // orchestrator's task-07 wiring and is asserted there, not here.
    const out = JSON.parse(r.stdout);
    assert.ok(out && typeof out === 'object' && !Array.isArray(out));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('PostCompact: telemetry is independent of the ledger file (no content in the log)', () => {
  const tmp = freshDir('log-no-ledger');
  try {
    const ledger = join(tmp, 'progress.md');
    writeFileSync(ledger, 'LEDGER CONTENT MARKER\n');
    const env = baseEnv(tmp, ledger);
    const r = runDispatcher({ session_id: 's-ledgerlog', trigger: 'manual' }, env);
    assert.equal(r.status, 0, r.stderr);
    const logFile = join(env.CLAUDE_PLUGIN_DATA, 'logs', 'post-compact.jsonl');
    const last = readLastJsonlLine(logFile);
    for (const key of Object.keys(last)) {
      assert.ok(!key.startsWith('ledger'), 'post-compact record is ledger-independent');
    }
    assert.ok(!readFileSync(logFile, 'utf8').includes('LEDGER CONTENT MARKER'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
