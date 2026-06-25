// Node tests for scripts/bench_runner_openrouter.mjs (pure functions only —
// no network, no real API, no real subprocess). Mirrors the coverage of the
// removed test/validators/test_bench_runner_openrouter.py.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  envOrDefault,
  isDocsPath,
  readTextIfExists,
  collectFixtureFiles,
  buildPrompt,
  extractJson,
  snapshotFile,
  snapshotFiles,
  applyFiles,
  runVerification,
  buildResult,
  writeResult,
  callOpenRouter,
  runMain,
} from '../../scripts/bench_runner_openrouter.mjs';

function makeTempDir(t, prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

// ---------- envOrDefault ----------

test('envOrDefault uses env value', () => {
  assert.equal(envOrDefault({ X: 'hello' }, 'X', 'def'), 'hello');
});

test('envOrDefault falls back to default when blank', () => {
  assert.equal(envOrDefault({ X: '   ' }, 'X', 'def'), 'def');
  assert.equal(envOrDefault({}, 'X', 'def'), 'def');
});

// ---------- isDocsPath ----------

test('isDocsPath: markdown-family extensions', () => {
  assert.equal(isDocsPath('guide.md'), true);
  assert.equal(isDocsPath('README.mdx'), true);
  assert.equal(isDocsPath('notes.markdown'), true);
  assert.equal(isDocsPath('intro.rst'), true);
  assert.equal(isDocsPath('intro.adoc'), true);
  assert.equal(isDocsPath('plain.txt'), true);
});

test('isDocsPath: docs directory segment', () => {
  assert.equal(isDocsPath('src/docs/intro.md'), true);
  assert.equal(isDocsPath('docs/guide.md'), true);
});

test('isDocsPath: readme / changelog / claude.md names', () => {
  assert.equal(isDocsPath('readme.txt'), true);
  assert.equal(isDocsPath('CHANGELOG'), true);
  assert.equal(isDocsPath('claude.md'), true);
});

test('isDocsPath: non-docs paths are false', () => {
  assert.equal(isDocsPath('src/app.py'), false);
  assert.equal(isDocsPath('lib/index.js'), false);
});

// ---------- readTextIfExists ----------

test('readTextIfExists returns empty string for missing path', () => {
  assert.equal(readTextIfExists(join('/no', 'such', 'path', 'here')), '');
});

test('readTextIfExists reads file content when present', (t) => {
  const d = makeTempDir(t, 'rtie-');
  const f = join(d, 'x.txt');
  writeFileSync(f, 'hello');
  assert.equal(readTextIfExists(f), 'hello');
});

// ---------- collectFixtureFiles ----------

test('collectFixtureFiles returns sorted posix-relative paths with content', (t) => {
  const d = makeTempDir(t, 'cff-');
  writeFileSync(join(d, 'a.py'), 'a');
  mkdirSync(join(d, 'sub'));
  writeFileSync(join(d, 'sub', 'b.py'), 'b');
  const files = collectFixtureFiles(d);
  assert.deepEqual(files.map((f) => f.path), ['a.py', 'sub/b.py']);
  assert.equal(files[0].content, 'a');
  assert.equal(files[1].content, 'b');
});

// ---------- buildPrompt ----------

test('buildPrompt produces system+user messages with task and guidance', () => {
  const task = { id: 't1', verification_required: true };
  const msgs = buildPrompt(task, [{ path: 'a.py', content: 'x' }], 'claude-body', 'guide-body');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('JSON only'));
  assert.equal(msgs[1].role, 'user');
  const user = msgs[1].content;
  assert.ok(user.includes('Repository guidance from CLAUDE.md:'), 'header present');
  assert.ok(user.includes('claude-body'), 'claude body present');
  assert.ok(user.includes('Additional guidance from the plugin README:'), 'guide header repointed');
  assert.ok(user.includes('guide-body'), 'guide body present');
  assert.ok(user.includes('Benchmark task:'));
  assert.ok(user.includes('"id": "t1"'));
  assert.ok(user.includes('Current fixture files:'));
  assert.ok(user.endsWith('Output JSON only.'));
});

// ---------- extractJson ----------

test('extractJson parses plain JSON', () => {
  assert.deepEqual(extractJson('{"a": 1}'), { a: 1 });
});

test('extractJson extracts embedded JSON object from prose', () => {
  const text = 'Here is the result:\n{"summary": "ok", "x": 2}\nThanks.';
  assert.deepEqual(extractJson(text), { summary: 'ok', x: 2 });
});

test('extractJson throws on no JSON', () => {
  assert.throws(() => extractJson('no json here at all'), SyntaxError);
});

test('extractJson throws on malformed embedded JSON', () => {
  assert.throws(() => extractJson('prefix {bad json} suffix'), SyntaxError);
});

// ---------- snapshotFile / snapshotFiles ----------

test('snapshotFile: text content', (t) => {
  const d = makeTempDir(t, 'sf-txt-');
  const p = join(d, 'f.txt');
  writeFileSync(p, 'hello');
  const snap = snapshotFile(p);
  assert.equal(snap.kind, 'text');
  assert.equal(snap.text, 'hello');
  assert.equal(snap.size, 5);
  assert.equal(snap.sha256.length, 64);
});

test('snapshotFile: binary content has no text field', (t) => {
  const d = makeTempDir(t, 'sf-bin-');
  const p = join(d, 'f.bin');
  writeFileSync(p, Buffer.from([0xff, 0xfe, 0x00]));
  const snap = snapshotFile(p);
  assert.equal(snap.kind, 'binary');
  assert.equal('text' in snap, false);
  assert.equal(snap.size, 3);
  assert.equal(snap.sha256.length, 64);
});

test('snapshotFiles: skips directories, keys by posix-relative path', (t) => {
  const d = makeTempDir(t, 'sfs-');
  writeFileSync(join(d, 'a.py'), 'a');
  mkdirSync(join(d, 'sub')); // directory entry skipped
  writeFileSync(join(d, 'sub', 'b.py'), 'b');
  const snap = snapshotFiles(d);
  assert.deepEqual(Object.keys(snap).sort(), ['a.py', 'sub/b.py']);
});

test('snapshotFiles + applyFiles round-trip detects changed files', (t) => {
  const d = makeTempDir(t, 'rt-');
  writeFileSync(join(d, 'keep.py'), 'orig');
  writeFileSync(join(d, 'gone.py'), 'orig');
  const before = snapshotFiles(d);
  // Simulate a model overwrite + addition, plus a deletion (the runner does
  // not delete files itself, but snapshot diffing must still detect one when
  // it happens — e.g. a model tool later removes a file).
  applyFiles(
    [
      { path: 'keep.py', content: 'changed' },
      { path: 'new.py', content: 'fresh' },
    ],
    d,
  );
  rmSync(join(d, 'gone.py'));
  const after = snapshotFiles(d);
  const all = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [...all]
    .filter((p) => JSON.stringify(before[p]) !== JSON.stringify(after[p]))
    .sort();
  assert.deepEqual(changed, ['gone.py', 'keep.py', 'new.py']);
  assert.equal(readFileSync(join(d, 'keep.py'), 'utf-8'), 'changed');
  assert.equal(readFileSync(join(d, 'new.py'), 'utf-8'), 'fresh');
  assert.equal(existsSync(join(d, 'gone.py')), false);
});

// ---------- applyFiles (path-escape guards) ----------

test('applyFiles writes nested file and creates parent dirs', (t) => {
  const d = makeTempDir(t, 'af-write-');
  applyFiles([{ path: 'sub/a.py', content: 'print(1)' }], d);
  assert.equal(readFileSync(join(d, 'sub', 'a.py'), 'utf-8'), 'print(1)');
});

test('applyFiles rejects absolute path', (t) => {
  const d = makeTempDir(t, 'af-abs-');
  assert.throws(
    () => applyFiles([{ path: '/etc/passwd', content: 'x' }], d),
    /Unsafe output path/,
  );
});

test('applyFiles rejects parent traversal', (t) => {
  const d = makeTempDir(t, 'af-dotdot-');
  assert.throws(
    () => applyFiles([{ path: '../escape.py', content: 'x' }], d),
    /Unsafe output path/,
  );
});

test('applyFiles rejects a path resolving outside workdir via prefix collision', (t) => {
  // workdir is /tmp/abc; a sibling /tmp/abc-evil is not under it, but the
  // prefix check uses a separator so '/tmp/abc-evil/x' does not start with
  // '/tmp/abc/'. We exercise the guard directly with an absolute-style rel
  // that path.resolve turns into an outside path.
  const d = makeTempDir(t, 'af-escape-');
  // Construct a path that resolves outside: join workdir with an absolute path
  // via resolve() collapses it, so use a deeply nested .. instead.
  assert.throws(
    () => applyFiles([{ path: 'nested/../../escape.py', content: 'x' }], d),
    /Unsafe output path|Path escaped workdir/,
  );
});

// ---------- buildResult + writeResult (result.json schema) ----------

test('writeResult writes result.json with every required schema field', (t) => {
  const outDir = makeTempDir(t, 'wr-');
  const result = buildResult({
    taskId: 't1',
    status: 'passed',
    completed: true,
    verificationRequired: false,
    testsRun: false,
    testsPassed: false,
    reviewRequired: false,
    reviewPresent: false,
    docsRequired: false,
    docsUpdated: false,
    changedFiles: ['a.py'],
    reviewStatus: 'approved',
    verificationLog: 'no tests needed',
    summary: 'done',
    model: 'anthropic/claude-sonnet-4.5',
  });
  writeResult(result, outDir);
  assert.ok(existsSync(join(outDir, 'result.json')));
  const written = JSON.parse(readFileSync(join(outDir, 'result.json'), 'utf-8'));
  const expectedFields = [
    'task_id', 'status', 'completed', 'verification_required', 'tests_run',
    'tests_passed', 'review_required', 'review_present', 'docs_required',
    'docs_updated', 'policy_violations', 'tool_failures', 'runtime_seconds', 'notes',
  ];
  for (const f of expectedFields) assert.ok(f in written, `missing ${f}`);
  assert.equal(written.task_id, 't1');
  assert.equal(written.status, 'passed');
  assert.equal(written.completed, true);
  assert.equal(written.policy_violations, 0);
  assert.equal(written.tool_failures, 0);
  assert.equal(written.runtime_seconds, 0);
  assert.ok(written.notes.includes('OpenRouter model='));
  assert.ok(written.notes.includes('Changed files: a.py'));
  // Trailing newline + 2-space indent.
  assert.ok(readFileSync(join(outDir, 'result.json'), 'utf-8').endsWith('\n'));
});

test('buildResult sets tool_failures=1 when status is failed', () => {
  const r = buildResult({
    taskId: 't2', status: 'failed', completed: false, changedFiles: [],
    reviewStatus: '', verificationLog: '', summary: '', model: 'm',
  });
  assert.equal(r.tool_failures, 1);
});

// ---------- runVerification (mocked spawn) ----------

test('runVerification: no test files returns [false, message]', (t) => {
  const d = makeTempDir(t, 'rv-none-');
  const [ok, msg] = runVerification(d);
  assert.equal(ok, false);
  assert.ok(msg.includes('No Node test files'));
});

test('runVerification: runs node --test via injected spawn, returns [true, output] on rc 0', (t) => {
  const d = makeTempDir(t, 'rv-pass-');
  writeFileSync(join(d, 'x.test.mjs'), "import {test} from 'node:test'\n");
  const calls = [];
  const fakeSpawn = (cmd, argv, opts) => {
    calls.push({ cmd, argv, cwd: opts.cwd });
    return { status: 0, stdout: '1 passed', stderr: '' };
  };
  const [ok, msg] = runVerification(d, { spawn: fakeSpawn });
  assert.equal(ok, true);
  assert.ok(msg.includes('1 passed'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'node');
  assert.deepEqual(calls[0].argv, ['--test']);
  assert.equal(calls[0].cwd, d);
});

test('runVerification: returns [false, output] on rc 1', (t) => {
  const d = makeTempDir(t, 'rv-fail-');
  writeFileSync(join(d, 'x.test.mjs'), "import {test} from 'node:test'\n");
  const fakeSpawn = () => ({ status: 1, stdout: '1 failed', stderr: 'err' });
  const [ok, msg] = runVerification(d, { spawn: fakeSpawn });
  assert.equal(ok, false);
  assert.ok(msg.includes('1 failed'));
  assert.ok(msg.includes('err'));
});

test('runVerification: detects tests/ subdir as a test source', (t) => {
  const d = makeTempDir(t, 'rv-sub-');
  mkdirSync(join(d, 'tests'));
  writeFileSync(join(d, 'tests', 'a.test.mjs'), "import {test} from 'node:test'\n");
  const fakeSpawn = () => ({ status: 0, stdout: 'ok', stderr: '' });
  const [ok] = runVerification(d, { spawn: fakeSpawn });
  assert.equal(ok, true);
});

// ---------- callOpenRouter (mocked fetch) ----------

test('callOpenRouter: string content returned directly', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: 'raw' } }] }),
    text: async () => '',
  });
  const out = await callOpenRouter([], { apiKey: 'k', fetchFn: fakeFetch });
  assert.equal(out, 'raw');
});

test('callOpenRouter: joins text parts from list content', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: [
            { type: 'text', text: 'alpha ' },
            { type: 'image', text: 'ignore' },
            { type: 'text', text: 'beta' },
          ],
        },
      }],
    }),
    text: async () => '',
  });
  const out = await callOpenRouter([], { apiKey: 'k', fetchFn: fakeFetch });
  assert.equal(out, 'alpha beta');
});

test('callOpenRouter: HTTP error raises with status + body', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({}),
    text: async () => 'rate-limited',
  });
  await assert.rejects(
    callOpenRouter([], { apiKey: 'k', fetchFn: fakeFetch }),
    /HTTP error 429/,
  );
});

test('callOpenRouter: network failure raises request-failed message', async () => {
  const fakeFetch = async () => { throw new Error('conn refused'); };
  await assert.rejects(
    callOpenRouter([], { apiKey: 'k', fetchFn: fakeFetch }),
    /request failed/,
  );
});

// ---------- runMain (end-to-end with mocked fetch + spawn) ----------

function writeTask(p, overrides = {}) {
  const task = {
    id: 't1', verification_required: false, review_required: false, docs_required: false,
    ...overrides,
  };
  writeFileSync(p, JSON.stringify(task));
}

function fakeFetchReturning(files, reviewStatus = 'approved', verificationNotes = '') {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({
        summary: 's', review_status: reviewStatus, verification_notes: verificationNotes,
        files, notes: 'n',
      }) } }],
    }),
    text: async () => '',
  });
}

test('runMain: passed with no requirements and a changed file', async (t) => {
  const d = makeTempDir(t, 'rm-pass-');
  const repoRoot = join(d, 'repo');
  const workdir = join(d, 'workdir');
  const outputDir = join(d, 'output');
  mkdirSync(repoRoot);
  mkdirSync(workdir);
  writeFileSync(join(repoRoot, 'CLAUDE.md'), 'c');
  writeFileSync(join(workdir, 'calc.test.mjs'), "import {test} from 'node:test';\nimport {strict as a} from 'node:assert';\ntest('ok',()=>{a.equal(1,1);});\n");
  const taskFile = join(d, 'task.json');
  writeTask(taskFile);
  const env = {
    BENCH_REPO_ROOT: repoRoot, BENCH_TASK_FILE: taskFile,
    BENCH_WORKDIR: workdir, BENCH_OUTPUT_DIR: outputDir,
    OPENROUTER_API_KEY: 'k',
  };
  const rc = await runMain(env, { fetchFn: fakeFetchReturning([{ path: 'a.py', content: 'x' }]) });
  assert.equal(rc, 0);
  const result = JSON.parse(readFileSync(join(outputDir, 'result.json'), 'utf-8'));
  assert.equal(result.status, 'passed');
  assert.equal(result.completed, true);
});

test('runMain: failed when no files changed', async (t) => {
  const d = makeTempDir(t, 'rm-nofiles-');
  const repoRoot = join(d, 'repo');
  const workdir = join(d, 'workdir');
  const outputDir = join(d, 'output');
  mkdirSync(repoRoot);
  mkdirSync(workdir);
  writeFileSync(join(repoRoot, 'CLAUDE.md'), 'c');
  const taskFile = join(d, 'task.json');
  writeTask(taskFile);
  const env = {
    BENCH_REPO_ROOT: repoRoot, BENCH_TASK_FILE: taskFile,
    BENCH_WORKDIR: workdir, BENCH_OUTPUT_DIR: outputDir,
    OPENROUTER_API_KEY: 'k',
  };
  await runMain(env, { fetchFn: fakeFetchReturning([]) });
  const result = JSON.parse(readFileSync(join(outputDir, 'result.json'), 'utf-8'));
  assert.equal(result.status, 'failed');
  assert.equal(result.completed, false);
});

test('runMain: failed when verification_required and tests fail', async (t) => {
  const d = makeTempDir(t, 'rm-vrfail-');
  const repoRoot = join(d, 'repo');
  const workdir = join(d, 'workdir');
  const outputDir = join(d, 'output');
  mkdirSync(repoRoot);
  mkdirSync(workdir);
  writeFileSync(join(repoRoot, 'CLAUDE.md'), 'c');
  writeFileSync(join(workdir, 'calc.test.mjs'), "import {test} from 'node:test'\n");
  const taskFile = join(d, 'task.json');
  writeTask(taskFile, { verification_required: true });
  const env = {
    BENCH_REPO_ROOT: repoRoot, BENCH_TASK_FILE: taskFile,
    BENCH_WORKDIR: workdir, BENCH_OUTPUT_DIR: outputDir,
    OPENROUTER_API_KEY: 'k',
  };
  const failingSpawn = () => ({ status: 1, stdout: '1 failed', stderr: '' });
  await runMain(env, {
    fetchFn: fakeFetchReturning([{ path: 'a.py', content: 'x' }]),
    spawn: failingSpawn,
  });
  const result = JSON.parse(readFileSync(join(outputDir, 'result.json'), 'utf-8'));
  assert.equal(result.status, 'failed');
  assert.equal(result.tests_run, true);
  assert.equal(result.tests_passed, false);
});

test('runMain: failed when review_required and review_status missing', async (t) => {
  const d = makeTempDir(t, 'rm-revfail-');
  const repoRoot = join(d, 'repo');
  const workdir = join(d, 'workdir');
  const outputDir = join(d, 'output');
  mkdirSync(repoRoot);
  mkdirSync(workdir);
  writeFileSync(join(repoRoot, 'CLAUDE.md'), 'c');
  const taskFile = join(d, 'task.json');
  writeTask(taskFile, { review_required: true });
  const env = {
    BENCH_REPO_ROOT: repoRoot, BENCH_TASK_FILE: taskFile,
    BENCH_WORKDIR: workdir, BENCH_OUTPUT_DIR: outputDir,
    OPENROUTER_API_KEY: 'k',
  };
  await runMain(env, { fetchFn: fakeFetchReturning([{ path: 'a.py', content: 'x' }], '') });
  const result = JSON.parse(readFileSync(join(outputDir, 'result.json'), 'utf-8'));
  assert.equal(result.status, 'failed');
  assert.equal(result.review_present, false);
});

test('runMain: failed when docs_required and changed file is not docs', async (t) => {
  const d = makeTempDir(t, 'rm-docsfail-');
  const repoRoot = join(d, 'repo');
  const workdir = join(d, 'workdir');
  const outputDir = join(d, 'output');
  mkdirSync(repoRoot);
  mkdirSync(workdir);
  writeFileSync(join(repoRoot, 'CLAUDE.md'), 'c');
  const taskFile = join(d, 'task.json');
  writeTask(taskFile, { docs_required: true });
  const env = {
    BENCH_REPO_ROOT: repoRoot, BENCH_TASK_FILE: taskFile,
    BENCH_WORKDIR: workdir, BENCH_OUTPUT_DIR: outputDir,
    OPENROUTER_API_KEY: 'k',
  };
  await runMain(env, { fetchFn: fakeFetchReturning([{ path: 'a.py', content: 'x' }]) });
  const result = JSON.parse(readFileSync(join(outputDir, 'result.json'), 'utf-8'));
  assert.equal(result.status, 'failed');
  assert.equal(result.docs_updated, false);
});

test('runMain: passed when docs_required and a docs file is updated', async (t) => {
  const d = makeTempDir(t, 'rm-docspass-');
  const repoRoot = join(d, 'repo');
  const workdir = join(d, 'workdir');
  const outputDir = join(d, 'output');
  mkdirSync(repoRoot);
  mkdirSync(workdir);
  writeFileSync(join(repoRoot, 'CLAUDE.md'), 'c');
  const taskFile = join(d, 'task.json');
  writeTask(taskFile, { docs_required: true });
  const env = {
    BENCH_REPO_ROOT: repoRoot, BENCH_TASK_FILE: taskFile,
    BENCH_WORKDIR: workdir, BENCH_OUTPUT_DIR: outputDir,
    OPENROUTER_API_KEY: 'k',
  };
  await runMain(env, { fetchFn: fakeFetchReturning([{ path: 'guide.md', content: 'x' }]) });
  const result = JSON.parse(readFileSync(join(outputDir, 'result.json'), 'utf-8'));
  assert.equal(result.status, 'passed');
  assert.equal(result.docs_updated, true);
});