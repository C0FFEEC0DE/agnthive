// Node ESM port of scripts/bench_runner_openrouter.py.
//
// One-shot benchmark coding worker that calls the OpenRouter chat-completions
// API, applies the model's file outputs to the benchmark workdir, optionally
// runs `node --test`, and writes result.json to the per-task output directory.
//
// Invoked by scripts/run-benchmark.mjs via spawnSync with stdio:'inherit' and a
// childEnv carrying BENCH_TASK_FILE / BENCH_TASK_ID / BENCH_OUTPUT_DIR /
// BENCH_WORKDIR / BENCH_FIXTURE_DIR / BENCH_REPO_ROOT plus the OpenRouter
// credentials. No CLI args — everything is env. Node standard library only.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, relative as relativePath, resolve, sep, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------- env helpers ----------

/** Read name from env, returning default when unset/blank (mirrors env_or_default). */
export function envOrDefault(env, name, def) {
  const v = (env[name] ?? '').trim();
  return v || def;
}

// ---------- pure helpers ----------

const DOCS_SUFFIXES = ['.md', '.mdx', '.txt', '.rst', '.adoc', '.markdown'];

/** True for documentation-shaped paths (mirrors is_docs_path). */
export function isDocsPath(pathStr) {
  const lower = String(pathStr).toLowerCase();
  const name = lower.split('/').pop();
  return (
    DOCS_SUFFIXES.some((ext) => lower.endsWith(ext)) ||
    lower.includes('/docs/') ||
    name.startsWith('readme') ||
    name.startsWith('changelog') ||
    name === 'claude.md'
  );
}

/** Read and return UTF-8 text, or '' when the path does not exist. */
export function readTextIfExists(p) {
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf-8');
}

/** Recursively collect files under root as {path, content} (posix-relative). */
export function collectFixtureFiles(root) {
  const files = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) files.push(p);
    }
  }
  walk(root);
  files.sort();
  return files.map((p) => ({
    path: relativePath(root, p).split(sep).join(posix.sep),
    content: readFileSync(p, 'utf-8'),
  }));
}

/** Build the system+user chat messages for the benchmark task. */
export function buildPrompt(task, fixtureFiles, claudeMd, guideMd) {
  const taskJson = JSON.stringify(task, null, 2);
  const filesJson = JSON.stringify(fixtureFiles, null, 2);
  const systemPrompt =
    'You are a one-shot benchmark coding worker. ' +
    'You receive a small codebase fixture and a task. ' +
    'Follow the repository guidance below, but do not invent tool execution or hidden automation. ' +
    'Do not mention release or deploy. ' +
    'Respond with JSON only using this schema: ' +
    '{"summary": string, "review_status": string, "verification_notes": string, ' +
    '"files": [{"path": string, "content": string}], "notes": string}. ' +
    'Return full file contents for each file you want to overwrite. Paths must be relative and stay inside the fixture.';
  const userPrompt =
    'Repository guidance from CLAUDE.md:\n' +
    `${claudeMd}\n\n` +
    'Additional guidance from the plugin README:\n' +
    `${guideMd}\n\n` +
    'Benchmark task:\n' +
    `${taskJson}\n\n` +
    'Current fixture files:\n' +
    `${filesJson}\n\n` +
    'Output JSON only.';
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/** Parse JSON, tolerating surrounding prose by extracting the first {...} block. */
export function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) throw new SyntaxError('No JSON object found in response');
    return JSON.parse(match[0]);
  }
}

/**
 * Snapshot a single file as {kind, sha256, size, text?} (mirrors snapshot_file).
 * A file is treated as text only when its bytes are valid UTF-8: Node's
 * Buffer.toString('utf-8') substitutes U+FFFD for invalid bytes instead of
 * throwing (unlike Python's bytes.decode), so validity is checked by
 * round-tripping the decoded string back to bytes and comparing.
 */
export function snapshotFile(p) {
  const data = readFileSync(p);
  const digest = createHash('sha256').update(data).digest('hex');
  const text = data.toString('utf-8');
  if (Buffer.from(text, 'utf-8').equals(data)) {
    return { kind: 'text', sha256: digest, size: data.length, text };
  }
  return { kind: 'binary', sha256: digest, size: data.length };
}

/** Snapshot every file under root, keyed by posix-relative path. */
export function snapshotFiles(root) {
  const snap = {};
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) {
        snap[relativePath(root, p).split(sep).join(posix.sep)] = snapshotFile(p);
      }
    }
  }
  walk(root);
  return snap;
}

/**
 * Apply model-output files into workdir. Rejects absolute paths and parent
 * traversal, plus a post-resolve escape guard: the resolved target must stay
 * within the resolved workdir. Mirrors the Python apply_files guards; the
 * symlink-resolving edge from the Python test is not replicated (Node has no
 * pathlib.resolve(strict=False) equivalent that resolves symlinks for
 * not-yet-existing paths), but the absolute/`..`/prefix checks cover the
 * concrete escape vectors.
 */
export function applyFiles(files, workdir) {
  const workdirResolved = resolve(workdir);
  for (const entry of files) {
    const rel = String(entry.path);
    const parts = rel.split('/').filter((s) => s.length > 0);
    if (rel.startsWith('/') || parts.includes('..')) {
      throw new Error(`Unsafe output path from model: ${rel}`);
    }
    const target = resolve(workdir, rel);
    if (target !== workdirResolved && !target.startsWith(workdirResolved + sep)) {
      throw new Error(`Path escaped workdir: ${rel}`);
    }
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, entry.content, 'utf-8');
  }
}

/**
 * Run `node --test` in workdir. Returns [passed, combinedOutput]. When no Node
 * test files exist, returns [false, message]. spawnFn is injectable for testing.
 * Node's test runner discovers *.test.mjs / test-*.mjs / test.mjs (and the .js
 * spellings) when invoked as `node --test` with no path arguments.
 */
export function runVerification(
  workdir,
  { spawn = spawnSync, timeout = 300000 } = {},
) {
  const hasTests = (() => {
    function check(dir) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const ent of entries) {
        const p = join(dir, ent.name);
        if (
          ent.isFile() &&
          (/\.test\.mjs$/.test(ent.name) ||
            /^test-.*\.mjs$/.test(ent.name) ||
            ent.name === 'test.mjs')
        )
          return true;
        if (ent.isDirectory() && ent.name === 'tests') {
          // tests/*.mjs
          try {
            for (const sub of readdirSync(p, { withFileTypes: true })) {
              if (sub.isFile() && sub.name.endsWith('.mjs')) return true;
            }
          } catch {}
        }
      }
      return false;
    }
    return check(workdir);
  })();
  if (!hasTests) return [false, 'No Node test files were found in the fixture.'];

  const completed = spawn('node', ['--test'], {
    cwd: workdir,
    encoding: 'utf-8',
    timeout,
  });
  const output = `${completed.stdout ?? ''}\n${completed.stderr ?? ''}`.trim();
  return [completed.status === 0, output];
}

/**
 * Call the OpenRouter chat-completions API. Returns the assistant message text
 * (joining text parts when content is a list). fetchFn is injectable for testing.
 */
export async function callOpenRouter(messages, opts) {
  const {
    apiKey,
    model = 'anthropic/claude-sonnet-4.5',
    baseUrl = 'https://openrouter.ai/api/v1/chat/completions',
    siteUrl = 'https://github.com',
    appName = 'agent-hive-benchmark',
    fetchFn,
    timeoutMs = 180000,
  } = opts;
  const payload = { model, messages, temperature: 0 };
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': siteUrl,
    'X-Title': appName,
  };
  const doFetch = fetchFn ?? globalThis.fetch;
  let response;
  try {
    response = await doFetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (err) {
    throw new Error(`OpenRouter request failed: ${err}`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenRouter HTTP error ${response.status}: ${detail}`);
  }
  const body = await response.json();
  const content = body.choices[0].message.content;
  if (Array.isArray(content)) {
    return content
      .filter((item) => item && typeof item === 'object' && item.type === 'text')
      .map((item) => item.text ?? '')
      .join('');
  }
  return content;
}

/** Compose the result.json object (mirrors the Python result dict). */
export function buildResult({
  taskId,
  status,
  completed,
  verificationRequired,
  testsRun,
  testsPassed,
  reviewRequired,
  reviewPresent,
  docsRequired,
  docsUpdated,
  changedFiles,
  reviewStatus,
  verificationLog,
  summary,
  model,
}) {
  return {
    task_id: taskId,
    status,
    completed,
    verification_required: verificationRequired,
    tests_run: testsRun,
    tests_passed: testsPassed,
    review_required: reviewRequired,
    review_present: reviewPresent,
    docs_required: docsRequired,
    docs_updated: docsUpdated,
    policy_violations: 0,
    tool_failures: status === 'passed' ? 0 : 1,
    runtime_seconds: 0,
    notes: (
      `OpenRouter model=${model}. ` +
      `Summary: ${(summary ?? '').trim()} ` +
      `Review: ${reviewStatus || 'missing'}. ` +
      `Changed files: ${changedFiles.length ? changedFiles.join(', ') : 'none'}. ` +
      `Verification: ${(verificationLog ?? '').slice(0, 800)}`
    ).trim(),
  };
}

/** Write result.json (UTF-8, 2-space indent, trailing newline) to outputDir. */
export function writeResult(result, outputDir) {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'result.json'), JSON.stringify(result, null, 2) + '\n', 'utf-8');
}

// ---------- main ----------

/**
 * Run the full benchmark flow. env is the process env (or a test double);
 * opts allows injecting fetchFn / spawn for testing. Returns 0 on
 * success (always — failures are reflected in result.status).
 */
export async function runMain(env, opts = {}) {
  const repoRoot = resolve(env.BENCH_REPO_ROOT);
  const taskFile = resolve(env.BENCH_TASK_FILE);
  const workdir = resolve(env.BENCH_WORKDIR);
  const outputDir = resolve(env.BENCH_OUTPUT_DIR);

  const apiKey = (env.OPENROUTER_API_KEY ?? '').trim();
  const model = envOrDefault(env, 'OPENROUTER_MODEL', 'anthropic/claude-sonnet-4.5');
  const baseUrl = envOrDefault(env, 'OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1/chat/completions');
  const siteUrl = envOrDefault(env, 'OPENROUTER_SITE_URL', 'https://github.com');
  const appName = envOrDefault(env, 'OPENROUTER_APP_NAME', 'agent-hive-benchmark');

  const task = JSON.parse(readFileSync(taskFile, 'utf-8'));
  const fixtureFiles = collectFixtureFiles(workdir);
  const before = snapshotFiles(workdir);

  const claudeMd = readTextIfExists(join(repoRoot, 'CLAUDE.md'));
  const guideMd = readTextIfExists(join(repoRoot, 'plugins', 'agent-hive', 'README.md'));

  const rawResponse = await callOpenRouter(buildPrompt(task, fixtureFiles, claudeMd, guideMd), {
    apiKey, model, baseUrl, siteUrl, appName, fetchFn: opts.fetchFn,
  });
  const modelResult = extractJson(rawResponse);
  applyFiles(modelResult.files ?? [], workdir);

  const after = snapshotFiles(workdir);
  const allPaths = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changedFiles = [...allPaths]
    .filter((p) => JSON.stringify(before[p]) !== JSON.stringify(after[p]))
    .sort();
  const docsUpdated = changedFiles.some((p) => isDocsPath(p));
  const completed = changedFiles.length > 0;

  const verificationRequired = Boolean(task.verification_required);
  let testsRun = false;
  let testsPassed = false;
  let verificationLog = (modelResult.verification_notes ?? '').trim();
  if (verificationRequired) {
    testsRun = true;
    const [passed, verificationOutput] = runVerification(workdir, opts);
    testsPassed = passed;
    verificationLog = verificationLog ? `${verificationLog}\n\n${verificationOutput}` : verificationOutput;
  }

  const reviewRequired = Boolean(task.review_required);
  const reviewStatus = (modelResult.review_status ?? '').trim();
  const reviewPresent = Boolean(reviewStatus);

  const docsRequired = Boolean(task.docs_required);
  let status = 'passed';
  if (!completed) status = 'failed';
  if (verificationRequired && !testsPassed) status = 'failed';
  if (reviewRequired && !reviewPresent) status = 'failed';
  if (docsRequired && !docsUpdated) status = 'failed';

  const result = buildResult({
    taskId: task.id,
    status,
    completed,
    verificationRequired,
    testsRun,
    testsPassed,
    reviewRequired,
    reviewPresent,
    docsRequired,
    docsUpdated,
    changedFiles,
    reviewStatus,
    verificationLog,
    summary: modelResult.summary ?? '',
    model,
  });

  writeResult(result, outputDir);
  return 0;
}

function main() {
  runMain(process.env).then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`bench_runner_openrouter: ${err?.stack ?? err}\n`);
      process.exit(1);
    },
  );
}

const isMain = (() => {
  try {
    return fileURLToPath(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) main();