// Node tests for the ADR-0012 arm x repetition execution matrix in
// scripts/run-benchmark.mjs.
//
// The outcome suite compares up to three arms (native = no plugin, legacy =
// plugin with the legacy profile, lean = plugin with the lean profile) over
// paired repetitions. These tests pin the ORCHESTRATOR contract: which cells
// are planned, what the child sees in its environment, where the artifacts
// land, and that a cell which cannot run is reported as a failure - never as
// a pass.
//
// No model and no network: the fake runner is a local Node script.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, readFileSync, chmodSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parseArmsFlag,
  parseRepsFlag,
  parseArmProfileFlag,
  profileForArm,
  resolveTaskArms,
  resolveTaskReps,
  cellEnv,
} from '../../scripts/run-benchmark.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'run-benchmark.mjs');

// A fake runner that records the cell it was asked to run, so the orchestrator
// contract (env, output dir) is observable from the artifact.
function writeRecordingRunner(p) {
  writeFileSync(p, `#!/usr/bin/env node
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const outDir = process.env.BENCH_OUTPUT_DIR;
mkdirSync(outDir, { recursive: true });
appendFileSync(join(outDir, 'cells.log'), JSON.stringify({
  arm: process.env.BENCH_ARM,
  rep: process.env.BENCH_REP,
  disable_plugin: process.env.BENCH_DISABLE_PLUGIN || '',
  workflow_profile: process.env.AGNTHIVE_WORKFLOW_PROFILE || '',
  workdir: process.env.BENCH_WORKDIR,
  output_dir: outDir,
}) + '\\n');
writeFileSync(join(outDir, 'result.json'), JSON.stringify({
  task_id: process.env.BENCH_TASK_ID, status: 'passed', completed: true,
  verification_required: false, tests_run: false, tests_passed: false,
  review_required: false, review_present: false, docs_required: false,
  docs_updated: false, policy_violations: 0, tool_failures: 0,
  runtime_seconds: 1, notes: 'recorded cell',
}));
`);
  chmodSync(p, 0o755);
}

function tmpd(t, prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

// The task is derived from a REAL suite task so it satisfies the outcome
// schema (the runner validates the contract before it spawns, and a task that
// does not validate fails as a staging failure, not as a matrix cell).
const BASE_TASK = join(REPO, 'bench', 'tasks', 'outcomes', 'tasks', 'outcome-minor-change-optunit.json');

function writeOutcomeTask(p, id, arms) {
  const src = JSON.parse(readFileSync(BASE_TASK, 'utf-8'));
  src.id = id;
  src.arms = arms;
  writeFileSync(p, JSON.stringify(src, null, 2));
}

// A task from a suite that is NOT schema-validated by the outcome validator
// (the smoke suites have no `suite: "outcomes"`). Its id is therefore only
// constrained by the orchestrator itself, which is what these tests pin.
function writePlainTask(p, id) {
  writeFileSync(p, JSON.stringify({
    id, category: 'bugfix', fixture: 'text-report',
    review_required: false, docs_required: false, verification_required: false,
  }, null, 2));
}


// The runner's --task-list-file takes ONE TASK PATH PER LINE. Writing the
// task JSON itself there would make every pretty-printed line a "task".
function writeTaskList(p, taskPath) {
  writeFileSync(p, taskPath + '\n');
}

function runScript(t, { args = [], runner, env = {} } = {}) {
  const d = tmpd(t, 'rb-arms-');
  // The output dir and the copied Claude profile must be SIBLINGS: the
  // runner copies the profile into the cell workdir, and copying a
  // directory into its own subdirectory is an error.
  const outputDir = join(d, 'out');
  const profileDir = join(d, 'profile');
  mkdirSync(profileDir, { recursive: true });
  const r = spawnSync(process.execPath, [SCRIPT, '--output-dir', outputDir, ...args], {
    cwd: REPO,
    encoding: 'utf-8',
    env: {
      ...process.env,
      BENCH_RUNNER_CMD: `${process.execPath} ${runner}`,
      BENCH_CLAUDE_PROFILE_DIR: profileDir,
      ...env,
    },
  });
  return { r, outputDir, d };
}

// ---------- pure helpers ----------

test('parseArmsFlag accepts a suite-arm subset and rejects unknown arms', () => {
  const ok = parseArmsFlag('native,lean');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.arms, ['native', 'lean']);
  const empty = parseArmsFlag('');
  assert.equal(empty.ok, true);
  assert.equal(empty.arms, null);
  const bad = parseArmsFlag('native,bogus');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown arm/);
});

test('parseRepsFlag accepts a positive integer and rejects the rest', () => {
  assert.deepEqual(parseRepsFlag('3'), { ok: true, reps: 3 });
  assert.deepEqual(parseRepsFlag(''), { ok: true, reps: null });
  assert.equal(parseRepsFlag('0').ok, false);
  assert.equal(parseRepsFlag('-2').ok, false);
  assert.equal(parseRepsFlag('two').ok, false);
});

test('parseArmProfileFlag accepts legacy|lean only', () => {
  assert.equal(parseArmProfileFlag('lean').profile, 'lean');
  assert.equal(parseArmProfileFlag('').profile, 'legacy');
  assert.equal(parseArmProfileFlag('native').ok, false);
});

test('profileForArm maps the arm to the plugin workflow profile', () => {
  assert.equal(profileForArm('native'), null);
  assert.equal(profileForArm('legacy'), 'legacy');
  assert.equal(profileForArm('lean'), 'lean');
});

test('resolveTaskArms intersects the request with the task declaration', () => {
  const task = { arms: ['native', 'legacy'] };
  assert.deepEqual(resolveTaskArms(task, ['native', 'lean'], 'legacy'), ['native']);
  // A task that declares nothing runs the requested arms.
  assert.deepEqual(resolveTaskArms({ arms: [] }, ['legacy', 'lean'], 'legacy'), ['legacy', 'lean']);
  // Without a request the run stays on ONE arm: the matrix is opt-in, so the
  // existing CI invocation and its model spend are unchanged.
  assert.deepEqual(resolveTaskArms(task, null, 'legacy'), ['legacy']);
  assert.deepEqual(resolveTaskArms({ arms: [] }, null, 'lean'), ['lean']);
});

test('resolveTaskReps defaults to the suite floor only for a matrix run', () => {
  assert.equal(resolveTaskReps({}, 5, true), 5);
  assert.equal(resolveTaskReps({}, null, true), 3);
  assert.equal(resolveTaskReps({}, null, false), 1);
});

test('cellEnv carries the cell identity and the arm-specific runtime switches', () => {
  const native = cellEnv('native', 2);
  assert.equal(native.BENCH_ARM, 'native');
  assert.equal(native.BENCH_REP, '2');
  assert.equal(native.BENCH_DISABLE_PLUGIN, '1');
  // The native arm loads no plugin, so it carries no workflow profile.
  assert.equal(native.AGNTHIVE_WORKFLOW_PROFILE, undefined);
  const lean = cellEnv('lean', 1);
  assert.equal(lean.AGNTHIVE_WORKFLOW_PROFILE, 'lean');
  assert.equal(lean.BENCH_DISABLE_PLUGIN, undefined);
});

// ---------- orchestration ----------

test('the matrix runs every (task, arm, rep) cell and records it', (t) => {
  const d = tmpd(t, 'rb-matrix-');
  const runner = join(d, 'runner.mjs');
  writeRecordingRunner(runner);
  const taskFile = join(d, 'task.json');
  writeOutcomeTask(taskFile, 'outcome-arm-cell', ['native', 'legacy', 'lean']);
  const taskList = join(d, 'tasks.txt');
  writeTaskList(taskList, taskFile);

  const { r, outputDir } = runScript(t, {
    args: ['--mode', 'command', '--task-list-file', taskList, '--arms', 'native,legacy,lean', '--reps', '2'],
    runner,
  });
  assert.equal(r.status, 0, r.stderr);

  // 1 task x 3 arms x 2 reps = 6 cells.
  const summary = JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf-8'));
  assert.equal(summary.totals.configured_tasks, 6);
  assert.equal(summary.totals.executed_tasks, 6);
  assert.equal(summary.totals.passed, 6);
  assert.equal(summary.totals.unexecuted_tasks, 0);
  assert.equal(summary.tasks.length, 6);
  for (const t of summary.tasks) {
    assert.ok(['native', 'legacy', 'lean'].includes(t.arm), `unexpected arm ${t.arm}`);
    assert.ok([1, 2].includes(t.rep), `unexpected rep ${t.rep}`);
    assert.equal(t.status, 'passed');
  }
  // Every (arm, rep) pair appears exactly once.
  const seen = new Set(summary.tasks.map((t) => `${t.arm}:${t.rep}`));
  assert.equal(seen.size, 6);
});

test('the child sees the cell identity and the arm-specific switches', (t) => {
  const d = tmpd(t, 'rb-env-');
  const runner = join(d, 'runner.mjs');
  writeRecordingRunner(runner);
  const taskFile = join(d, 'task.json');
  writeOutcomeTask(taskFile, 'outcome-arm-env', ['native', 'legacy', 'lean']);
  const taskList = join(d, 'tasks.txt');
  writeTaskList(taskList, taskFile);

  const { r, outputDir } = runScript(t, {
    args: ['--mode', 'command', '--task-list-file', taskList, '--arms', 'native,legacy,lean', '--reps', '1'],
    runner,
  });
  assert.equal(r.status, 0, r.stderr);

  const cells = [];
  for (const arm of ['native', 'legacy', 'lean']) {
    const log = join(outputDir, 'arms', arm, 'tasks', 'outcome-arm-env', 'rep-1', 'cells.log');
    assert.ok(existsSync(log), `missing cell log for arm ${arm}`);
    cells.push(JSON.parse(readFileSync(log, 'utf-8').trim()));
  }
  const native = cells.find((c) => c.arm === 'native');
  assert.equal(native.rep, '1');
  assert.equal(native.disable_plugin, '1');
  assert.equal(native.workflow_profile, '');
  const legacy = cells.find((c) => c.arm === 'legacy');
  assert.equal(legacy.workflow_profile, 'legacy');
  assert.equal(legacy.disable_plugin, '');
  const lean = cells.find((c) => c.arm === 'lean');
  assert.equal(lean.workflow_profile, 'lean');
  // The native arm is a genuine no-plugin baseline: the runner decides that
  // from BENCH_DISABLE_PLUGIN, so the orchestrator must not contradict it.
  assert.equal(native.disable_plugin, '1');
});

test('a matrix run writes one summary per arm for the suite emitter', (t) => {
  const d = tmpd(t, 'rb-perarm-');
  const runner = join(d, 'runner.mjs');
  writeRecordingRunner(runner);
  const taskFile = join(d, 'task.json');
  writeOutcomeTask(taskFile, 'outcome-per-arm', ['native', 'legacy', 'lean']);
  const taskList = join(d, 'tasks.txt');
  writeTaskList(taskList, taskFile);

  const { r, outputDir } = runScript(t, {
    args: ['--mode', 'command', '--task-list-file', taskList, '--arms', 'native,legacy,lean', '--reps', '2'],
    runner,
  });
  assert.equal(r.status, 0, r.stderr);

  for (const arm of ['native', 'legacy', 'lean']) {
    const armSummaryPath = join(outputDir, 'arms', arm, 'summary.json');
    assert.ok(existsSync(armSummaryPath), `missing per-arm summary for ${arm}`);
    const armSummary = JSON.parse(readFileSync(armSummaryPath, 'utf-8'));
    assert.equal(armSummary.arm, arm);
    // Only that arm's cells are in the arm summary - the suite emitter takes
    // ONE arm per run directory.
    assert.equal(armSummary.tasks.length, 2);
    for (const t of armSummary.tasks) assert.equal(t.arm, arm);
  }
});

test('a single-arm run keeps the flat layout and does not multiply the spend', (t) => {
  const d = tmpd(t, 'rb-flat-');
  const runner = join(d, 'runner.mjs');
  writeRecordingRunner(runner);
  const taskFile = join(d, 'task.json');
  writeOutcomeTask(taskFile, 'outcome-flat', ['native', 'legacy', 'lean']);
  const taskList = join(d, 'tasks.txt');
  writeTaskList(taskList, taskFile);

  const { r, outputDir } = runScript(t, {
    args: ['--mode', 'command', '--task-list-file', taskList],
    runner,
  });
  assert.equal(r.status, 0, r.stderr);

  const summary = JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf-8'));
  assert.equal(summary.totals.executed_tasks, 1, 'a run without --arms executes the task once');
  // The historical artifact path stays valid for the existing CI invocation.
  assert.ok(existsSync(join(outputDir, 'tasks', 'outcome-flat', 'result.json')));
});

test('a failing cell is reported as a failure, never as a pass', (t) => {
  const d = tmpd(t, 'rb-fail-');
  const runner = join(d, 'runner.mjs');
  writeFileSync(runner, `#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const outDir = process.env.BENCH_OUTPUT_DIR;
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'result.json'), JSON.stringify({
  task_id: process.env.BENCH_TASK_ID, status: 'failed', completed: false,
  verification_required: false, tests_run: false, tests_passed: false,
  review_required: false, review_present: false, docs_required: false,
  docs_updated: false, policy_violations: 0, tool_failures: 0,
  runtime_seconds: 1, notes: 'synthetic failure',
}));
`);
  chmodSync(runner, 0o755);
  const taskFile = join(d, 'task.json');
  writeOutcomeTask(taskFile, 'outcome-fail-cell', ['native', 'legacy']);
  const taskList = join(d, 'tasks.txt');
  writeTaskList(taskList, taskFile);

  const { r, outputDir } = runScript(t, {
    args: ['--mode', 'command', '--task-list-file', taskList, '--arms', 'native,legacy', '--reps', '1'],
    runner,
  });
  assert.equal(r.status, 0, r.stderr);

  const summary = JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf-8'));
  // Both cells ran and both failed: a failing cell is never counted as a pass.
  assert.equal(summary.totals.executed_tasks, 2);
  assert.equal(summary.totals.passed, 0);
  assert.equal(summary.tasks.length, 2);
  for (const t of summary.tasks) assert.equal(t.status, 'failed');
  // The unresolved bookkeeping is TASK-level (one task failed in two arms),
  // while the per-cell truth stays in summary.tasks.
  assert.equal(summary.totals.unresolved_tasks, 1);
  assert.deepEqual(summary.unresolved_task_ids, ['outcome-fail-cell']);
});

test('a crashed runner fails only its own cell and the matrix keeps running', (t) => {
  const d = tmpd(t, 'rb-crash-');
  const runner = join(d, 'runner.mjs');
  // This fake runner reproduces the live infrastructure flake: the Claude Code
  // child aborted with a filesystem error (the CLI iterates a lock file a
  // sibling session removed) and the runner died with the child's exit code.
  writeFileSync(runner, `#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const outDir = process.env.BENCH_OUTPUT_DIR;
mkdirSync(outDir, { recursive: true });
if (process.env.BENCH_ARM === 'legacy' && process.env.BENCH_REP === '1') {
  process.stderr.write('terminate called after throwing an instance of std::filesystem::__cxx11::filesystem_error\\n');
  process.exit(134);
}
writeFileSync(join(outDir, 'result.json'), JSON.stringify({
  task_id: process.env.BENCH_TASK_ID, status: 'passed', completed: true,
  verification_required: false, tests_run: false, tests_passed: false,
  review_required: false, review_present: false, docs_required: false,
  docs_updated: false, policy_violations: 0, tool_failures: 0,
  runtime_seconds: 1, notes: 'recorded cell',
}));
`);
  chmodSync(runner, 0o755);
  const taskFile = join(d, 'task.json');
  writeOutcomeTask(taskFile, 'outcome-crash-cell', ['native', 'legacy']);
  const taskList = join(d, 'tasks.txt');
  writeTaskList(taskList, taskFile);

  const { r, outputDir } = runScript(t, {
    args: ['--mode', 'command', '--task-list-file', taskList, '--arms', 'native,legacy', '--reps', '2'],
    runner,
  });

  // The infrastructure failure stays visible: it is not a clean run.
  assert.notEqual(r.status, 0, 'a crashed runner must not look like a clean run');
  assert.match(r.stderr, /Benchmark infrastructure failures/);

  // ...and it costs only its own cell: every other cell still ran.
  const summary = JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf-8'));
  assert.equal(summary.tasks.length, 4);
  assert.equal(summary.totals.executed_tasks, 4);
  const crashed = summary.tasks.find((x) => x.arm === 'legacy' && x.rep === 1);
  assert.ok(crashed, 'the crashed cell must still be reported');
  assert.equal(crashed.status, 'failed');
  assert.match(crashed.notes, /runner_failed/);
  for (const o of summary.tasks.filter((x) => !(x.arm === 'legacy' && x.rep === 1))) {
    assert.equal(o.status, 'passed', `cell ${o.arm}:${o.rep} must not be affected by the crash`);
  }
  // The failed cell is a failure, never a pass.
  assert.equal(summary.totals.passed, 3);
});

test('a SIGABRT from the child side does not take the orchestrator down', (t) => {
  const d = tmpd(t, 'rb-abrt-');
  const runner = join(d, 'runner.mjs');
  // The live failure mode: the Claude Code CLI's background daemon aborts and
  // the abort signal reaches the orchestrator's process group. A Node process
  // never raises SIGABRT on its own, so the orchestrator must survive it and
  // report the affected cell as failed.
  writeFileSync(runner, `#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const outDir = process.env.BENCH_OUTPUT_DIR;
mkdirSync(outDir, { recursive: true });
if (process.env.BENCH_ARM === 'legacy' && process.env.BENCH_REP === '1') {
  process.kill(process.ppid, 'SIGABRT');
  // The signal is delivered asynchronously: keep the process alive long
  // enough for it to land on the orchestrator.
  const t = Date.now();
  while (Date.now() - t < 2000) { /* wait for the signal */ }
  process.exit(0);
}
writeFileSync(join(outDir, 'result.json'), JSON.stringify({
  task_id: process.env.BENCH_TASK_ID, status: 'passed', completed: true,
  verification_required: false, tests_run: false, tests_passed: false,
  review_required: false, review_present: false, docs_required: false,
  docs_updated: false, policy_violations: 0, tool_failures: 0,
  runtime_seconds: 1, notes: 'recorded cell',
}));
`);
  chmodSync(runner, 0o755);
  const taskFile = join(d, 'task.json');
  writeOutcomeTask(taskFile, 'outcome-abrt-cell', ['native', 'legacy']);
  const taskList = join(d, 'tasks.txt');
  writeTaskList(taskList, taskFile);

  const { r, outputDir } = runScript(t, {
    args: ['--mode', 'command', '--task-list-file', taskList, '--arms', 'native,legacy', '--reps', '2'],
    runner,
  });

  // The orchestrator survived and still wrote the summaries.
  assert.ok(existsSync(join(outputDir, 'summary.json')), 'the summary must be written after a SIGABRT');
  const summary = JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf-8'));
  assert.equal(summary.tasks.length, 4);
  // The cell that was interrupted is a failure, never a pass.
  const interrupted = summary.tasks.find((x) => x.arm === 'legacy' && x.rep === 1);
  assert.ok(interrupted, 'the interrupted cell must still be reported');
  assert.equal(interrupted.status, 'failed');
  // The other cells are unaffected.
  for (const o of summary.tasks.filter((x) => !(x.arm === 'legacy' && x.rep === 1))) {
    assert.equal(o.status, 'passed', `cell ${o.arm}:${o.rep} must not be affected`);
  }
});

test('an invalid --arms value fails loudly instead of running a wrong matrix', (t) => {
  const d = tmpd(t, 'rb-bad-');
  const runner = join(d, 'runner.mjs');
  writeRecordingRunner(runner);
  const taskFile = join(d, 'task.json');
  writeOutcomeTask(taskFile, 'outcome-bad-arm', ['native']);
  const taskList = join(d, 'tasks.txt');
  writeTaskList(taskList, taskFile);

  const { r } = runScript(t, {
    args: ['--mode', 'command', '--task-list-file', taskList, '--arms', 'native,bogus'],
    runner,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Invalid --arms/);
});

// ---------- task id -> directory name ----------
//
// A task id becomes a directory name under the run output, and the id comes
// from a task file: untrusted input. These tests pin the two failure modes
// that a raw id caused - writing OUTSIDE the run directory, and aborting the
// whole run with ENAMETOOLONG - and pin that the REPORTED id stays the real
// one, so the summary still names the task that ran.

test('a task id with path traversal cannot write outside the run directory', (t) => {
  const d = tmpd(t, 'rb-traversal-');
  const runner = join(d, 'runner.mjs');
  writeRecordingRunner(runner);
  const escapeTarget = join(d, 'ESCAPED');
  const taskFile = join(d, 'task.json');
  // The id tries to climb out of the run directory and back into `d`.
  writePlainTask(taskFile, '../../' + escapeTarget);
  const taskList = join(d, 'tasks.txt');
  writeTaskList(taskList, taskFile);

  const { r, outputDir } = runScript(t, {
    args: ['--mode', 'command', '--task-list-file', taskList],
    runner,
  });
  assert.equal(r.status, 0, r.stderr);

  // Nothing was written to the escape target: the artifacts stayed inside the
  // run directory.
  assert.ok(!existsSync(escapeTarget), 'task id escaped the run directory');
  const taskDirs = readdirSync(join(outputDir, 'tasks'));
  assert.equal(taskDirs.length, 1, 'exactly one task directory was created');
  for (const name of taskDirs) {
    assert.ok(!name.includes('..'), 'task directory name carries no traversal');
  }

  // The REPORTED id is still the original one - the summary names the task
  // that actually ran, it does not silently rename it.
  const summary = JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf-8'));
  assert.equal(summary.tasks.length, 1);
  assert.equal(summary.tasks[0].task_id, '../../' + escapeTarget);
  assert.equal(summary.tasks[0].status, 'passed');
});

test('an over-long task id fails that task only, never the whole run', (t) => {
  const d = tmpd(t, 'rb-longid-');
  const runner = join(d, 'runner.mjs');
  writeRecordingRunner(runner);
  // An id far past the 255-byte filename limit.
  const longId = 'outcome-' + 'a'.repeat(300);
  const taskFile = join(d, 'task.json');
  writePlainTask(taskFile, longId);
  const taskList = join(d, 'tasks.txt');
  writeTaskList(taskList, taskFile);

  const { r, outputDir } = runScript(t, {
    args: ['--mode', 'command', '--task-list-file', taskList],
    runner,
  });
  // The run completes instead of dying with ENAMETOOLONG.
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /ENAMETOOLONG/);

  const summary = JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf-8'));
  assert.equal(summary.totals.executed_tasks, 1);
  assert.equal(summary.tasks[0].task_id, longId);
  assert.equal(summary.tasks[0].status, 'passed');
});

test('a task id that is safe keeps the historical artifact path', (t) => {
  const d = tmpd(t, 'rb-safeid-');
  const runner = join(d, 'runner.mjs');
  writeRecordingRunner(runner);
  const taskFile = join(d, 'task.json');
  writeOutcomeTask(taskFile, 'outcome-safe-id', ['native']);
  const taskList = join(d, 'tasks.txt');
  writeTaskList(taskList, taskFile);

  const { r, outputDir } = runScript(t, {
    args: ['--mode', 'command', '--task-list-file', taskList],
    runner,
  });
  assert.equal(r.status, 0, r.stderr);
  // The CI artifact layout does not move for an ordinary id.
  assert.ok(existsSync(join(outputDir, 'tasks', 'outcome-safe-id', 'result.json')));
});
