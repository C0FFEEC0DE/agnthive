// Node port of the HARD-FAILING checks in the former pytest suite
// (test/validators/test_task_fixture_alignment.py) — verifies that benchmark
// tasks and their fixtures are not already misaligned (docs already present,
// feature already implemented, bug already fixed). Dependency-free: targeted
// text/brace parsing of JS fixtures, no js-yaml, no child_process.exec.
//
// Only the three asserting checks are ported here. The soft/no-op checks from
// the Python suite (refactor complexity, success-criteria/category alignment,
// required-transcript-pattern coverage, prompt-mentions-category-actions) only
// compute values into throwaway variables and never assert, so they are dropped.
// Structural checks (fixture existence, valid required_used_agents) already live
// in scripts/validate.mjs and are not duplicated here.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// test/validators/task-fixture-alignment.test.mjs -> parents[2] == repo root
const REPO_ROOT = join(__dirname, '..', '..');
const FIXTURES_DIR = join(REPO_ROOT, 'bench', 'fixtures');
const TASKS_DIR = join(REPO_ROOT, 'bench', 'tasks');

// Patterns indicating fixture README already has docs content.
const QUICKSTART_PATTERNS = ['node --test', 'npm test', 'quickstart', 'usage', 'getting started'];
// Proper error handling — presence means a division bug is already fixed.
// The fix is adding a throw guard for a zero divisor in the JS fixture.
const BUG_PATTERNS = ['throw new Error', 'throw Error'];
// Stub markers — indicate an incomplete implementation (OK for feature tasks).
const STUB_INDICATORS = ['return 0', 'TODO', '// stub'];
// Operators/keywords that indicate a real (working) JS implementation, not a
// stub. The arithmetic operators and control-flow keywords are bare substrings;
// '&&'/'||' are bare too (no leading-space ambiguity in JS, unlike Python's
// ' and'/' or').
const LOGIC_OPS = ['+', '-', '*', '/', '&&', '||', 'if', 'for', 'while'];

/** Recursively collect files ending in `ext` under `dir` (sorted, deterministic). */
function walkGlob(dir, ext) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walkGlob(p, ext));
    } else if (ent.isFile() && ent.name.endsWith(ext)) {
      out.push(p);
    }
  }
  return out;
}

/** Load all task definitions under bench/tasks, tagged with their file path. */
function loadAllTasks() {
  return walkGlob(TASKS_DIR, '.json')
    .sort()
    .map((taskPath) => {
      const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
      task._path = taskPath;
      return task;
    });
}

/** Read a fixture README.md, or null when absent. */
function getFixtureReadme(fixtureName) {
  const readmePath = join(FIXTURES_DIR, fixtureName, 'README.md');
  return existsSync(readmePath) ? readFileSync(readmePath, 'utf-8') : null;
}

/** Read a fixture source file, or null when absent. */
function getFixtureSource(fixtureName, sourceFile) {
  const sourcePath = join(FIXTURES_DIR, fixtureName, sourceFile);
  return existsSync(sourcePath) ? readFileSync(sourcePath, 'utf-8') : null;
}

/** Escape regex metacharacters in a literal string (mirrors Python re.escape). */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Declaration detectors for JS fixtures: `function name(...)` declarations and
// `const|let|var name = ... =>` arrow forms (with or without a block body).
const FUNC_RE = /(?:export\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/;
const ARROW_RE = /(?:const|let|var)\s+(\w+)\s*=\s*(?:\([^)]*\)|\w+)\s*=>\s*\{?/;

/**
 * Extract JS function definitions and their bodies via brace/expression capture
 * (small fixture files — no AST needed). Both `function name(args) {` and
 * `const name = (args) => {` / `const name = arg => expr` forms are recognized.
 * The body is the inline remainder of the declaration line (after `{` for
 * functions, after `=>` for arrows) plus any following lines until the next
 * top-level function/arrow declaration or EOF. Each entry is { name, body }.
 */
function extractFunctions(source) {
  const lines = source.split('\n');
  const decls = [];
  for (let i = 0; i < lines.length; i++) {
    const fm = lines[i].match(FUNC_RE);
    if (fm) {
      decls.push({ idx: i, name: fm[1], kind: 'func' });
      continue;
    }
    const am = lines[i].match(ARROW_RE);
    if (am) {
      decls.push({ idx: i, name: am[1], kind: 'arrow' });
    }
  }
  const funcs = [];
  for (let d = 0; d < decls.length; d++) {
    const { idx, name, kind } = decls[d];
    const start = idx + 1;
    const end = d + 1 < decls.length ? decls[d + 1].idx : lines.length;
    const bodyLines = lines.slice(start, end);
    // Inline remainder of the declaration line: after the opening `{` for
    // function declarations, after `=>` for arrow forms.
    const declLine = lines[idx];
    let inlineBody = '';
    if (kind === 'func') {
      const braceIdx = declLine.indexOf('{');
      if (braceIdx !== -1 && braceIdx < declLine.length - 1) {
        inlineBody = declLine.slice(braceIdx + 1);
      }
    } else {
      const arrowIdx = declLine.indexOf('=>');
      if (arrowIdx !== -1 && arrowIdx + 2 < declLine.length) {
        inlineBody = declLine.slice(arrowIdx + 2);
      }
    }
    const body = [inlineBody, ...bodyLines].join('\n').trim();
    funcs.push({ name, body });
  }
  return funcs;
}

test('docs tasks have minimal fixture readmes', () => {
  // Docs tasks must not ship a fixture whose README already contains the
  // quickstart/usage content the task asks to add.
  for (const task of loadAllTasks()) {
    if (!task.docs_required) continue;
    const fixtureName = task.fixture;
    if (!fixtureName) continue;

    const readme = getFixtureReadme(fixtureName);
    if (readme === null) continue;

    const prompt = (task.prompt || '').toLowerCase();
    const readmeLower = readme.toLowerCase();
    const taskId = task.id;

    for (const pattern of QUICKSTART_PATTERNS) {
      const pat = pattern.toLowerCase();
      // Allow if the task explicitly references the existing content.
      if (!readmeLower.includes(pat)) continue;
      if (prompt.includes(pat)) continue;

      // Only flag when the prompt itself asks for a docs addition of this kind.
      if (prompt.includes('quickstart') || prompt.includes('node --test') || prompt.includes('npm test')) {
        assert.fail(
          `Task/fixture misalignment: ${taskId}\n` +
            `Task requires docs update but fixture README already contains '${pattern}'\n` +
            `Fixture: ${join(FIXTURES_DIR, fixtureName, 'README.md')}\n` +
            `Fix: Reset fixture README to minimal state or change task`,
        );
      }
    }
  }
});

test('feature tasks have incomplete fixtures', () => {
  // Feature tasks must not ship a fixture where the requested function is
  // already fully implemented (stubs like `return 0`/`TODO`/`// stub` are
  // allowed — they indicate an incomplete, to-be-implemented state).
  for (const task of loadAllTasks()) {
    if ((task.category || '') !== 'feature') continue;
    const fixtureName = task.fixture;
    if (!fixtureName) continue;

    for (const sourceFile of ['calculator.mjs', 'reporter.mjs']) {
      const source = getFixtureSource(fixtureName, sourceFile);
      if (source === null) continue;

      const prompt = (task.prompt || '').toLowerCase();
      const taskId = task.id;

      for (const { name: funcName, body: funcBody } of extractFunctions(source)) {
        const esc = escapeRegExp(funcName);
        // Does the prompt ask to add/implement/create this function?
        const implementPatterns = [
          new RegExp(`add(?:\\s+a)?\\s+${esc}`),
          new RegExp(`implement(?:\\s+the)?\\s+${esc}`),
          new RegExp(`create(?:\\s+a)?\\s+${esc}`),
          new RegExp(`implement(?:\\s+a)?\\s+${esc}\\s+(?:helper|function)`),
        ];
        const asksToImplement = implementPatterns.some((p) => p.test(prompt));
        if (!asksToImplement) continue;

        // A stub indicates an incomplete implementation — OK, skip.
        const isStub = STUB_INDICATORS.some((ind) => funcBody.includes(ind));
        if (isStub) continue;

        // Otherwise, if the body contains real logic, the fixture is already
        // done and the task is misaligned.
        const hasLogic = LOGIC_OPS.some((op) => funcBody.includes(op));
        if (hasLogic) {
          assert.fail(
            `Task/fixture misalignment: ${taskId}\n` +
              `Task requires implementing '${funcName}' but fixture already has working implementation\n` +
              `Fixture: ${join(FIXTURES_DIR, fixtureName, sourceFile)}\n` +
              `Fix: Remove implementation from fixture or change task`,
          );
        }
      }
    }
  }
});

test('bugfix tasks have unfixed fixtures', () => {
  // Bugfix tasks must not ship a fixture where the bug is already fixed (proper
  // error handling already present for the division-by-zero case).
  for (const task of loadAllTasks()) {
    if ((task.category || '') !== 'bugfix') continue;
    const fixtureName = task.fixture;
    if (!fixtureName) continue;

    for (const sourceFile of ['calculator.mjs']) {
      const source = getFixtureSource(fixtureName, sourceFile);
      if (source === null) continue;

      const prompt = (task.prompt || '').toLowerCase();
      const taskId = task.id;

      // Only inspect division-related bugfix tasks.
      if (!(prompt.includes('divide') || prompt.includes('division') || prompt.includes('zero'))) {
        continue;
      }

      for (const pattern of BUG_PATTERNS) {
        if (source.includes(pattern) && prompt.includes('zero')) {
          assert.fail(
            `Task/fixture misalignment: ${taskId}\n` +
              `Task requires fixing division bug but fixture already has '${pattern}'\n` +
              `Fixture: ${join(FIXTURES_DIR, fixtureName, sourceFile)}\n` +
              `Fix: Remove error handling from fixture or change task`,
          );
        }
      }
    }
  }
});