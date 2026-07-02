// Node port of tests/test_task_brief.py — tests scripts/task-brief.mjs.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'task-brief.mjs');

const PLAN = [
  '# Plan: widget feature',
  '',
  'Some preamble. Use it like:',
  '',
  '```',
  'make install',
  '```',
  '',
  '## Task 1: Scaffold',
  '',
  'Create the module.',
  '',
  '### Steps',
  '- add file',
  '',
  '## Task 2: Implement core',
  '',
  'Write the widget.',
  '',
  '### Subsection inside task 2',
  '',
  'Details here.',
  '',
  '```',
  '## this looks like a header but is inside a code block',
  'keep me',
  '```',
  '',
  '## Task 3: Verify',
  '',
  'Run tests.',
  '',
].join('\n');

function runBrief(planFile, n, briefDir) {
  const env = { ...process.env, CLAUDE_CREW_BRIEF_DIR: briefDir };
  return spawnSync(process.execPath, [SCRIPT, planFile, String(n)], {
    encoding: 'utf-8', env, cwd: REPO,
  });
}

function freshDir(label) {
  const d = join(tmpdir(), `tb-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

test('extracts named task with fence tracking and no leakage', () => {
  const d = freshDir('named');
  try {
    const plan = join(d, 'plan.md');
    writeFileSync(plan, PLAN);
    const briefDir = join(d, 'briefs');
    const r = runBrief(plan, 2, briefDir);
    assert.equal(r.status, 0, r.stderr);
    const printed = r.stdout.trim();
    assert.equal(printed, join(briefDir, 'task-2-brief.md'));
    const body = readFileSync(join(briefDir, 'task-2-brief.md'), 'utf-8');
    assert.ok(body.includes('## Task 2: Implement core'));
    assert.ok(body.includes('### Subsection inside task 2'));
    assert.ok(body.includes('## this looks like a header but is inside a code block'));
    assert.ok(body.includes('keep me'));
    assert.ok(!body.includes('Task 3: Verify'));
    assert.ok(!body.includes('Task 1: Scaffold'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('distinct tasks are extracted separately', () => {
  const d = freshDir('distinct');
  try {
    const plan = join(d, 'plan.md');
    writeFileSync(plan, PLAN);
    const briefDir = join(d, 'briefs');
    const r = runBrief(plan, 1, briefDir);
    assert.equal(r.status, 0, r.stderr);
    const body = readFileSync(join(briefDir, 'task-1-brief.md'), 'utf-8');
    assert.ok(body.includes('## Task 1: Scaffold'));
    assert.ok(body.includes('### Steps'));
    assert.ok(!body.includes('Task 2'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('missing task exits 1 with stderr message and no brief file', () => {
  const d = freshDir('missing');
  try {
    const plan = join(d, 'plan.md');
    writeFileSync(plan, PLAN);
    const briefDir = join(d, 'briefs');
    const r = runBrief(plan, 99, briefDir);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('task 99 not found'));
    assert.equal(existsSync(join(briefDir, 'task-99-brief.md')), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('bad number exits 2', () => {
  const d = freshDir('badn');
  try {
    const plan = join(d, 'plan.md');
    writeFileSync(plan, PLAN);
    const r = runBrief(plan, 'abc', join(d, 'briefs'));
    assert.equal(r.status, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('missing plan exits 2 with stderr message', () => {
  const d = freshDir('missplan');
  try {
    const r = runBrief(join(d, 'nope.md'), 1, join(d, 'briefs'));
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes('plan file not found'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});