#!/usr/bin/env node
// test-hooks.mjs — Node ESM hook fixture runner.
//
// Replaces the legacy Bash/jq/Python harness (scripts/test-hooks.sh +
// test/hooks/test-lib.sh). Loads test/hooks/cases.json (142 cases) and
// test/hooks/scenarios.json (2 scenarios) verbatim, feeds each fixture
// through the Node hook dispatcher (spawned with an explicit argv — no shell),
// and asserts the same expectations (exit code, stdout_jq, state_jq,
// stderr_regex, file_assertions) using a built-in jq-subset evaluator.
//
// Runtime: Node standard library ONLY. No Bash, Python, jq, GNU-only, or
// macOS-only dependency. The dispatcher is spawned via spawnSync with an
// explicit argv (no shell:true, no exec). State is read back through the
// plugin's own state.mjs (Node-stdlib-only) so the interpretation matches the
// dispatcher exactly.
//
// Cleanup: all per-run artifacts live under a single mkdtemp temp dir which is
// removed on exit. The runner never writes outside it (and never mutates the
// repo tree).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

// --- repo / plugin paths ----------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const pluginRoot = join(repoRoot, 'plugins', 'agent-hive');
const dispatcher = join(pluginRoot, 'modules', 'hook-dispatcher.mjs');
const hooksDir = join(repoRoot, 'test', 'hooks');
const casesPath = join(hooksDir, 'cases.json');
const scenariosPath = join(hooksDir, 'scenarios.json');
const deltasPath = join(hooksDir, 'deltas.json');

// Plugin state module (Node-stdlib-only) — used to read session state back so
// state_jq is evaluated against the exact same reducer the dispatcher uses.
// Use pathToFileURL so the dynamic import works on Windows, where a bare
// drive-letter path (D:\...) is not a valid ESM URL and would throw
// ERR_UNSUPPORTED_ESM_URL_SCHEME.
const { statePaths, loadState } = await import(pathToFileURL(join(pluginRoot, 'modules', 'state.mjs')).href);

// --- legacy-script -> dispatcher event (+ matcher) mapping ------------------
// Each legacy claudecfg/hooks/<name>.sh maps to one dispatcher event. Matchers
// mirror the registrations in plugins/agent-hive/hooks/hooks.json.
export const SCRIPT_TO_EVENT = {
  'pre-tool-use.sh': { event: 'PreToolUse', matcher: 'Bash' },
  'permission-request.sh': { event: 'PermissionRequest', matcher: 'Bash' },
  'permission-denied.sh': { event: 'PermissionDenied', matcher: 'Bash' },
  'post-bash.sh': { event: 'PostToolUse', matcher: 'Bash' },
  'post-edit-write.sh': { event: 'PostToolUse', matcher: 'EditWrite' },
  'post-tool-failure.sh': { event: 'PostToolUseFailure', matcher: 'Bash' },
  'stop-guard.sh': { event: 'Stop' },
  'subagent-start.sh': { event: 'SubagentStart' },
  'subagent-stop-guard.sh': { event: 'SubagentStop' },
  'task-completed.sh': { event: 'TaskCompleted' },
  'teammate-idle.sh': { event: 'TeammateIdle' },
  'session-start.sh': { event: 'SessionStart' },
  'session-end.sh': { event: 'SessionEnd' },
  'user-prompt-submit.sh': { event: 'UserPromptSubmit' },
  'notification.sh': { event: 'Notification' },
  'config-change.sh': { event: 'ConfigChange' },
  'instructions-loaded.sh': { event: 'InstructionsLoaded' },
  'pre-compact.sh': { event: 'PreCompact' },
  'post-compact.sh': { event: 'PostCompact' },
};

const EDIT_WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// Events the dispatcher registers handlers for (used to report unmapped gaps).
const DISPATCHER_EVENTS = new Set([
  'SessionStart', 'InstructionsLoaded', 'UserPromptSubmit', 'PreToolUse',
  'PermissionRequest', 'PermissionDenied', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'Stop', 'TeammateIdle', 'TaskCompleted',
  'Notification', 'ConfigChange', 'PreCompact', 'PostCompact', 'SessionEnd',
]);

function basename(p) {
  const s = p.replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Resolve the dispatcher event + matcher for a legacy script path, optionally
 * deriving the PreToolUse/PostToolUse matcher from the fixture's tool_name.
 */
function mapScriptToEvent(scriptPath, fixtureObj) {
  const base = basename(scriptPath);
  const entry = SCRIPT_TO_EVENT[base];
  if (!entry) return null;
  let matcher = entry.matcher ?? null;
  const toolName = fixtureObj?.tool_name ?? null;
  if (base === 'pre-tool-use.sh' && toolName && toolName !== 'Bash') {
    matcher = EDIT_WRITE_TOOLS.has(toolName) ? 'EditWrite' : toolName;
  }
  if (base === 'post-edit-write.sh' && toolName && EDIT_WRITE_TOOLS.has(toolName)) {
    matcher = 'EditWrite';
  }
  return { event: entry.event, matcher };
}

// --- placeholder resolution -------------------------------------------------
function resolvePlaceholders(value, caseTmp, caseHome) {
  if (typeof value !== 'string') return value;
  return value
    .replaceAll('__CASE_TMP__', caseTmp)
    .replaceAll('__CASE_HOME__', caseHome)
    .replaceAll('__REPO_ROOT__', repoRoot);
}

// Resolve a filesystem path from a manifest value: first expand placeholders,
// then if it is not absolute, anchor it to the repo root.
function resolveFsPath(raw, caseTmp, caseHome) {
  const expanded = resolvePlaceholders(raw, caseTmp, caseHome);
  return isAbsolute(expanded) ? expanded : join(repoRoot, expanded);
}

// --- POSIX-regex -> JS RegExp translation -----------------------------------
// file_assertions/stderr_regex were authored for grep -E (POSIX ERE). The only
// POSIX construct used in the corpus is the [[:space:]] character class; JS
// RegExp does not support POSIX classes, so translate it to \s. Everything
// else in the corpus (literals, ., *, +, ?, [...], |, anchors, escapes) is
// already valid JS RegExp syntax.
function posixRegexToJs(pattern) {
  return pattern.replaceAll('[[:space:]]', '\\s');
}

function regexTest(pattern, content) {
  try {
    return new RegExp(posixRegexToJs(pattern)).test(content);
  } catch (e) {
    throw new Error(`invalid regex ${JSON.stringify(pattern)}: ${e.message}`);
  }
}

// ===========================================================================
// jq-subset evaluator
// ===========================================================================
// A minimal recursive-descent parser + evaluator for the exact jq subset used
// by cases.json / scenarios.json stdout_jq and state_jq expressions. No shell
// out to jq. Supported constructs:
//   .                      identity
//   .a, .a.b, .a.b[0]      path access (with integer index)
//   |                      pipe (left-to-right)
//   and / or               boolean logic
//   == / !=                deep equality (arrays/objects) / scalar equality
//   contains("s")          string contains
//   index("s")             first index or null (jq semantics)
//   has("k")               object has own key
//   length                 string/array/object length
//   sort                    sorted copy of an array
//   not                    logical negation (as a pipe filter)
//   "..." true false null  literals
//   123                    integer literals
//   [a, b, ...]            array literals (elements are pipe expressions)
//   ( ... )                grouping
// If a construct outside this subset is encountered, evalJq throws with the
// offending token so the caller can report it (never silently skipped).
//
// Documented divergences from jq (safe for the current corpus because the
// dispatcher always emits a complete schema; noted so a future case with a
// conditionally-absent field does not mask a dispatcher bug jq would surface):
//   - Object literals `{...}` are NOT supported (tokenizer throws on `{`).
//     Every corpus expression uses array literals only.
//   - `contains`/`length`/`sort`/`index`/`has`/`test` on null or a wrong type
//     return a benign value (false/0/input/null) instead of erroring as jq
//     would. The dispatcher emits the full schema so these paths are not hit.
//   - `sort` uses JS `<`/`>` comparison, matching jq lexicographic order for
//     ASCII lowercase strings (the only arrays the corpus sorts). Mixed-case
//     or numeric arrays would order differently than jq.

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  const isIdentStart = (c) => /[a-zA-Z_]/.test(c);
  const isIdent = (c) => /[a-zA-Z0-9_]/.test(c);
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '"') { // string literal
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else { out += src[j]; j++; }
      }
      if (j >= n) throw new Error('unterminated string in jq expression');
      tokens.push({ kind: 'str', value: out });
      i = j + 1;
      continue;
    }
    if (c === '=' && src[i + 1] === '=') { tokens.push({ kind: 'eq' }); i += 2; continue; }
    if (c === '!' && src[i + 1] === '=') { tokens.push({ kind: 'ne' }); i += 2; continue; }
    if (c === '|') { tokens.push({ kind: 'pipe' }); i++; continue; }
    if (c === '(') { tokens.push({ kind: 'lparen' }); i++; continue; }
    if (c === ')') { tokens.push({ kind: 'rparen' }); i++; continue; }
    if (c === '[') { tokens.push({ kind: 'lbracket' }); i++; continue; }
    if (c === ']') { tokens.push({ kind: 'rbracket' }); i++; continue; }
    if (c === ',') { tokens.push({ kind: 'comma' }); i++; continue; }
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < n && src[j] >= '0' && src[j] <= '9') j++;
      tokens.push({ kind: 'num', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (c === '.') {
      // path: .[.a.b[0].c ...] or identity '.'
      const segs = [];
      let j = i + 1;
      // optional first identifier (it may also be a pipe/paren -> identity)
      if (j < n && isIdentStart(src[j])) {
        let k = j;
        while (k < n && isIdent(src[k])) k++;
        segs.push({ name: src.slice(j, k) });
        j = k;
      }
      // subsequent .name or [int]
      while (j < n && (src[j] === '.' || src[j] === '[')) {
        if (src[j] === '.') {
          let k = j + 1;
          if (k < n && isIdentStart(src[k])) {
            const start = k;
            while (k < n && isIdent(src[k])) k++;
            segs.push({ name: src.slice(start, k) });
            j = k;
          } else {
            break; // '.' not followed by ident -> not part of this path
          }
        } else { // '['
          let k = j + 1;
          if (k < n && src[k] >= '0' && src[k] <= '9') {
            const start = k;
            while (k < n && src[k] >= '0' && src[k] <= '9') k++;
            const idx = Number(src.slice(start, k));
            if (src[k] !== ']') throw new Error('expected ] after index in path');
            segs.push({ index: idx });
            j = k + 1;
          } else {
            break; // bracket not a simple int index -> stop
          }
        }
      }
      tokens.push({ kind: 'path', segs });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdent(src[j])) j++;
      const word = src.slice(i, j);
      tokens.push({ kind: 'word', value: word });
      i = j;
      continue;
    }
    throw new Error(`unexpected char ${JSON.stringify(c)} in jq expression`);
  }
  return tokens;
}

// Keywords / 0-arity filters distinguished from path names.
const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', 'null']);
const FUNCS1 = new Set(['contains', 'index', 'has', 'test']);
const FUNCS0 = new Set(['length', 'sort', 'not']);

class Parser {
  constructor(tokens) { this.tokens = tokens; this.pos = 0; }
  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }
  expect(kind) {
    const t = this.next();
    if (!t || t.kind !== kind) throw new Error(`expected ${kind}, got ${t ? t.kind : 'EOF'}`);
    return t;
  }

  parse() {
    const node = this.parsePipe();
    if (this.pos !== this.tokens.length) {
      throw new Error(`trailing tokens after jq expression at index ${this.pos}`);
    }
    return node;
  }

  // pipe (lowest precedence): a | b | c
  parsePipe() {
    let left = this.parseOr();
    while (this.peek() && this.peek().kind === 'pipe') {
      this.next();
      const right = this.parseOr();
      left = { type: 'pipe', left, right };
    }
    return left;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.peek() && this.peek().kind === 'word' && this.peek().value === 'or') {
      this.next();
      const right = this.parseAnd();
      left = { type: 'or', left, right };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseCompare();
    while (this.peek() && this.peek().kind === 'word' && this.peek().value === 'and') {
      this.next();
      const right = this.parseCompare();
      left = { type: 'and', left, right };
    }
    return left;
  }

  parseCompare() {
    let left = this.parsePrimary();
    while (this.peek() && (this.peek().kind === 'eq' || this.peek().kind === 'ne')) {
      const op = this.next().kind;
      const right = this.parsePrimary();
      left = { type: 'cmp', op, left, right };
    }
    return left;
  }

  parsePrimary() {
    const t = this.peek();
    if (!t) throw new Error('unexpected EOF in jq expression');
    if (t.kind === 'lparen') {
      this.next();
      const inner = this.parsePipe();
      this.expect('rparen');
      return inner;
    }
    if (t.kind === 'lbracket') {
      this.next();
      const elems = [];
      if (this.peek() && this.peek().kind !== 'rbracket') {
        elems.push(this.parsePipe());
        while (this.peek() && this.peek().kind === 'comma') {
          this.next();
          elems.push(this.parsePipe());
        }
      }
      this.expect('rbracket');
      return { type: 'array', elems };
    }
    if (t.kind === 'path') {
      this.next();
      return { type: 'path', segs: t.segs };
    }
    if (t.kind === 'str') {
      this.next();
      return { type: 'lit', value: t.value };
    }
    if (t.kind === 'num') {
      this.next();
      return { type: 'lit', value: t.value };
    }
    if (t.kind === 'word') {
      const w = t.value;
      if (w === 'true') { this.next(); return { type: 'lit', value: true }; }
      if (w === 'false') { this.next(); return { type: 'lit', value: false }; }
      if (w === 'null') { this.next(); return { type: 'lit', value: null }; }
      if (w === 'not') { this.next(); return { type: 'func0', name: 'not' }; }
      if (w === 'length' || w === 'sort') { this.next(); return { type: 'func0', name: w }; }
      if (FUNCS1.has(w)) {
        this.next();
        this.expect('lparen');
        const arg = this.parsePipe();
        this.expect('rparen');
        return { type: 'func1', name: w, arg };
      }
      throw new Error(`unsupported jq identifier ${JSON.stringify(w)}`);
    }
    throw new Error(`unexpected token ${t.kind} in jq primary`);
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let k = 0; k < a.length; k++) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

function jqEqual(a, b) {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (Array.isArray(a) || Array.isArray(b) || (a && typeof a === 'object') || (b && typeof b === 'object')) {
    return deepEqual(a, b);
  }
  return a === b;
}

function evalNode(node, input) {
  switch (node.type) {
    case 'lit': return node.value;
    case 'path': {
      let cur = input;
      for (const seg of node.segs) {
        if (cur == null) return null;
        if ('name' in seg) cur = cur[seg.name];
        else cur = cur[seg.index];
      }
      return cur === undefined ? null : cur;
    }
    case 'pipe': {
      const l = evalNode(node.left, input);
      return evalNode(node.right, l);
    }
    case 'and': return jqTruthy(evalNode(node.left, input)) && jqTruthy(evalNode(node.right, input));
    case 'or': return jqTruthy(evalNode(node.left, input)) || jqTruthy(evalNode(node.right, input));
    case 'cmp': {
      const l = evalNode(node.left, input);
      const r = evalNode(node.right, input);
      return node.op === 'eq' ? jqEqual(l, r) : !jqEqual(l, r);
    }
    case 'array': return node.elems.map((e) => evalNode(e, input));
    case 'func0': {
      if (node.name === 'not') return !jqTruthy(input);
      if (node.name === 'length') {
        if (input == null) return 0;
        if (typeof input === 'string' || Array.isArray(input)) return input.length;
        if (typeof input === 'object') return Object.keys(input).length;
        return 0;
      }
      if (node.name === 'sort') {
        if (!Array.isArray(input)) return input;
        return [...input].sort((a, b) => {
          if (a < b) return -1; if (a > b) return 1; return 0;
        });
      }
      throw new Error(`unknown func0 ${node.name}`);
    }
    case 'func1': {
      const arg = evalNode(node.arg, input);
      if (node.name === 'contains') {
        if (typeof input === 'string' && typeof arg === 'string') return input.includes(arg);
        if (Array.isArray(input) && Array.isArray(arg)) return arg.every((x) => input.some((y) => deepEqual(x, y)));
        if (input && typeof input === 'object' && arg && typeof arg === 'object') {
          for (const k of Object.keys(arg)) if (!deepEqual(input[k], arg[k])) return false;
          return true;
        }
        return false;
      }
      if (node.name === 'index') {
        if (typeof input === 'string') { const i = input.indexOf(arg); return i >= 0 ? i : null; }
        if (Array.isArray(input)) { const i = input.findIndex((x) => deepEqual(x, arg)); return i >= 0 ? i : null; }
        return null;
      }
      if (node.name === 'has') {
        return !!(input && typeof input === 'object' && Object.prototype.hasOwnProperty.call(input, arg));
      }
      if (node.name === 'test') {
        if (typeof input !== 'string' || typeof arg !== 'string') return false;
        try { return new RegExp(arg).test(input); } catch { return false; }
      }
      throw new Error(`unknown func1 ${node.name}`);
    }
    default:
      throw new Error(`unknown jq node type ${node.type}`);
  }
}

function jqTruthy(v) { return v !== false && v !== null && v !== undefined; }

/** Evaluate a jq expression against a value; returns the result. */
export function evalJq(expr, value) {
  const tokens = tokenize(expr);
  const ast = new Parser(tokens).parse();
  return evalNode(ast, value);
}

/** Evaluate a jq boolean assertion (mirrors `jq -e '<expr>'`). */
export function jqAssert(expr, value) {
  return jqTruthy(evalJq(expr, value));
}

// ===========================================================================
// manifest loading + structural validation (folded from test_hook_scenarios.py)
// ===========================================================================
function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertIs(obj, kind, label) {
  if (kind === 'array') { if (!Array.isArray(obj)) throw new Error(`${label}: expected an array`); }
  else if (kind === 'object') { if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error(`${label}: expected an object`); }
  else if (kind === 'nonempty_string') { if (typeof obj !== 'string' || !obj) throw new Error(`${label}: expected a non-empty string`); }
}

function fileExists(relOrAbs, label) {
  const p = isAbsolute(relOrAbs) ? relOrAbs : join(repoRoot, relOrAbs);
  if (!existsSync(p)) throw new Error(`${label} missing: ${p}`);
}

function validateCaseEntry(entry, seenNames) {
  assertIs(entry, 'object', 'case');
  assertIs(entry.name, 'nonempty_string', 'case name');
  assertIs(entry.script, 'nonempty_string', `${entry.name}: script`);
  assertIs(entry.stdin, 'nonempty_string', `${entry.name}: stdin`);
  // `script` is an event label (the basename of the legacy hook it exercises),
  // mapped via SCRIPT_TO_EVENT to a dispatcher event — it is NOT a file path the
  // harness executes (the single Node dispatcher is spawned instead). Only the
  // fixture (stdin) and optional seed_state/cwd are real files.
  fileExists(entry.stdin, `${entry.name} stdin`);
  if (entry.seed_state) fileExists(entry.seed_state, `${entry.name} seed_state`);
  if (entry.cwd) fileExists(entry.cwd, `${entry.name} cwd`);
  if (entry.env != null) assertIs(entry.env, 'object', `${entry.name}: env`);
  if (seenNames && seenNames.has(entry.name)) throw new Error(`duplicate case name: ${entry.name}`);
  if (seenNames) seenNames.add(entry.name);
  const base = basename(entry.script);
  if (!SCRIPT_TO_EVENT[base]) throw new Error(`${entry.name}: unmapped legacy script ${entry.script}`);
}

function validateScenarioEntry(scen, seenNames) {
  assertIs(scen, 'object', 'scenario');
  assertIs(scen.name, 'nonempty_string', 'scenario name');
  assertIs(scen.session_id, 'nonempty_string', `${scen.name}: session_id`);
  assertIs(scen.steps, 'array', `${scen.name}: steps`);
  if (scen.steps.length === 0) throw new Error(`${scen.name}: steps must be non-empty`);
  if (scen.seed_state) fileExists(scen.seed_state, `${scen.name} seed_state`);
  if (seenNames && seenNames.has(scen.name)) throw new Error(`duplicate scenario name: ${scen.name}`);
  if (seenNames) seenNames.add(scen.name);
  const stepNames = new Set();
  for (const step of scen.steps) {
    assertIs(step, 'object', `${scen.name}: step`);
    assertIs(step.name, 'nonempty_string', `${scen.name}: step name`);
    if (stepNames.has(step.name)) throw new Error(`${scen.name}: duplicate step name ${step.name}`);
    stepNames.add(step.name);
    assertIs(step.script, 'nonempty_string', `${scen.name}::${step.name}: script`);
    assertIs(step.stdin, 'nonempty_string', `${scen.name}::${step.name} stdin`);
    fileExists(step.stdin, `${scen.name}::${step.name} stdin`);
    if (step.seed_state) fileExists(step.seed_state, `${scen.name}::${step.name} seed_state`);
    if (step.cwd) fileExists(step.cwd, `${scen.name}::${step.name} cwd`);
    if (step.env != null) assertIs(step.env, 'object', `${scen.name}::${step.name}: env`);
    const base = basename(step.script);
    if (!SCRIPT_TO_EVENT[base]) throw new Error(`${scen.name}::${step.name}: unmapped legacy script ${step.script}`);
  }
}

// ===========================================================================
// state seeding + reading
// ===========================================================================
// Seed session state for the Node dispatcher by writing a single `init` event
// record. The reducer (state.mjs) starts from DEFAULT_STATE and applies `init`
// via Object.assign, so a partial seed is merged with the full default schema
// exactly as the dispatcher expects. The event is written with an exclusive
// 'wx' flag so a stale file would surface rather than be silently overwritten;
// each run uses a fresh temp data root so this never collides in practice.
function seedState(dataRoot, sessionId, seedStateObj) {
  const paths = statePaths(dataRoot, sessionId);
  mkdirSync(paths.eventsDir, { recursive: true });
  const payload = { ...seedStateObj, session_id: sessionId };
  const record = { seq: 1, type: 'init', payload, v: 1 };
  writeFileSync(join(paths.eventsDir, '0000000001.json'), JSON.stringify(record), { flag: 'wx' });
}

function readStateFor(dataRoot, sessionId) {
  try {
    return loadState(statePaths(dataRoot, sessionId));
  } catch {
    return null;
  }
}

// ===========================================================================
// dispatcher invocation
// ===========================================================================
function runDispatcher({ event, matcher, stdinJson, env, cwd }) {
  const args = [dispatcher, '--event', event];
  if (matcher) args.push('--matcher', matcher);
  const res = spawnSync(process.execPath, args, {
    input: stdinJson,
    encoding: 'utf8',
    env,
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return res;
}

// ===========================================================================
// case / scenario execution
// ===========================================================================
let totalCases = 0;
let totalScenarios = 0;
let passed = 0;
let failed = 0;
const failures = [];

function recordPass(runName, delta) {
  passed++;
  console.log(delta ? `PASS (delta): ${runName}` : `PASS: ${runName}`);
}

function recordFail(runName, reason) {
  failed++;
  failures.push({ runName, reason });
  console.log(`FAIL: ${runName} - ${reason}`);
}

// Build the per-spawn env: inherit a clean subset, set HOME + plugin env vars,
// merge the case-provided env (placeholders resolved).
function buildEnv(caseEnv, caseHome, caseTmp, workdir) {
  const env = {
    // Inherit only PATH so the node binary and system tools resolve; drop the
    // rest of the ambient environment to keep runs hermetic.
    PATH: process.env.PATH ?? '',
    HOME: caseHome,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_DATA: join(caseHome, '.claude'),
  };
  if (workdir) env.CLAUDE_PROJECT_DIR = workdir;
  if (caseEnv) {
    for (const [k, v] of Object.entries(caseEnv)) {
      env[k] = resolvePlaceholders(String(v), caseTmp, caseHome);
    }
  }
  return env;
}

// Execute one fixture through the dispatcher and check all assertions.
// `runName` is the reporting name; `entry` is the case/step object; `ctx`
// carries the per-run tmp/home and (for scenarios) the shared session id.
function executeEntry(runName, entry, ctx, delta) {
  totalCases++;
  const skip = new Set(delta?.skip ?? []);

  const fixtureRaw = loadJson(resolveFsPath(entry.stdin, ctx.caseTmp, ctx.caseHome));
  // For scenarios, override session_id with the shared scenario session id.
  const fixture = ctx.sessionId
    ? { ...fixtureRaw, session_id: ctx.sessionId }
    : fixtureRaw;

  const mapped = mapScriptToEvent(entry.script, fixture);
  if (!mapped) { recordFail(runName, `unmapped script ${entry.script}`); return; }
  if (!DISPATCHER_EVENTS.has(mapped.event)) {
    recordFail(runName, `dispatcher does not handle event ${mapped.event}`);
    return;
  }

  const stdinJson = JSON.stringify(fixture);
  const workdirRaw = entry.cwd ?? null;
  const workdir = workdirRaw ? resolveFsPath(workdirRaw, ctx.caseTmp, ctx.caseHome) : repoRoot;
  if (!existsSync(workdir)) { recordFail(runName, `working directory not found: ${workdir}`); return; }

  const env = buildEnv(entry.env ?? null, ctx.caseHome, ctx.caseTmp, workdir);
  const dataRoot = env.CLAUDE_PLUGIN_DATA;

  // Seed state before running (only when a session id is known).
  const sessionIdForState = fixture.session_id ?? ctx.sessionId ?? null;
  if (entry.seed_state && sessionIdForState) {
    const seed = loadJson(resolveFsPath(entry.seed_state, ctx.caseTmp, ctx.caseHome));
    seedState(dataRoot, sessionIdForState, seed);
  }

  const res = runDispatcher({
    event: mapped.event,
    matcher: mapped.matcher,
    stdinJson,
    env,
    cwd: workdir,
  });

  const expectedExit = entry.expect_exit ?? 0;
  if (res.status !== expectedExit) {
    recordFail(runName, `expected exit ${expectedExit}, got ${res.status}${res.stderr ? `; stderr: ${res.stderr.trim().slice(0, 300)}` : ''}`);
    return;
  }

  // stderr_regex (used by exit-2 TaskCompleted/TeammateIdle blocks).
  if (entry.stderr_regex) {
    if (!skip.has('stderr_regex')) {
      if (!regexTest(entry.stderr_regex, res.stderr ?? '')) {
        recordFail(runName, `stderr did not match regex: ${entry.stderr_regex}`);
        return;
      }
    }
  }

  // stdout_jq (dispatcher prints one JSON object on stdout for exit 0).
  if (entry.stdout_jq) {
    if (!skip.has('stdout_jq')) {
      if (!res.stdout || !res.stdout.trim()) { recordFail(runName, 'stdout was empty for stdout_jq assertion'); return; }
      let parsed;
      try { parsed = JSON.parse(res.stdout); } catch (e) { recordFail(runName, `stdout not valid JSON: ${e.message}`); return; }
      let ok;
      try { ok = jqAssert(entry.stdout_jq, parsed); }
      catch (e) { recordFail(runName, `stdout_jq evaluation error: ${e.message}`); return; }
      if (!ok) { recordFail(runName, `stdout JSON assertion failed: ${entry.stdout_jq}`); return; }
    }
  }

  // state_jq (read session state back through the dispatcher's state module).
  if (entry.state_jq) {
    if (!skip.has('state_jq')) {
      if (!sessionIdForState) { recordFail(runName, 'state assertion requires session_id'); return; }
      const state = readStateFor(dataRoot, sessionIdForState);
      if (!state) { recordFail(runName, 'expected session state not found'); return; }
      let ok;
      try { ok = jqAssert(entry.state_jq, state); }
      catch (e) { recordFail(runName, `state_jq evaluation error: ${e.message}`); return; }
      if (!ok) { recordFail(runName, `state assertion failed: ${entry.state_jq}`); return; }
    }
  }

  // file_assertions (resolve path, read, regex-test).
  if (entry.file_assertions) {
    for (const [idx, fa] of entry.file_assertions.entries()) {
      if (skip.has('file_assertions')) continue;
      if (skip.has(`file_assertion:${idx}`)) continue;
      const filePath = resolveFsPath(fa.path, ctx.caseTmp, ctx.caseHome);
      if (!existsSync(filePath)) { recordFail(runName, `expected file not found: ${filePath}`); return; }
      const content = readFileSync(filePath, 'utf8');
      if (!regexTest(fa.regex, content)) { recordFail(runName, `file assertion failed for ${filePath}: ${fa.regex}`); return; }
    }
  }

  recordPass(runName, delta && skip.size > 0);
}

// ===========================================================================
// deltas (intentional bash->Node behavior deltas)
// ===========================================================================
function loadDeltas() {
  if (!existsSync(deltasPath)) return new Map();
  const list = loadJson(deltasPath);
  const map = new Map();
  for (const d of list) {
    const key = d.scenario ? `${d.scenario}::${d.step}` : d.case;
    map.set(key, d);
  }
  return map;
}

// ===========================================================================
// main
// ===========================================================================
let tmpRoot = '';

function cleanup() {
  if (tmpRoot) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    tmpRoot = '';
  }
}

async function main() {
  // Ensure cleanup runs even on early throws / signals.
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  tmpRoot = mkdtempSync(join(tmpdir(), 'hook-tests-'));
  const deltas = loadDeltas();

  // --- manifest validation (folded structural checks) ---
  let validationError = null;
  try {
    const cases = loadJson(casesPath);
    assertIs(cases, 'array', 'cases.json');
    if (cases.length === 0) throw new Error('cases.json must be a non-empty array');
    const seen = new Set();
    for (const c of cases) validateCaseEntry(c, seen);
    const scenarios = loadJson(scenariosPath);
    assertIs(scenarios, 'array', 'scenarios.json');
    if (scenarios.length === 0) throw new Error('scenarios.json must be a non-empty array');
    const seenScen = new Set();
    for (const s of scenarios) validateScenarioEntry(s, seenScen);
  } catch (e) {
    validationError = e.message;
  }

  console.log('=== Hook Behavior Tests (Node runner) ===');
  console.log(`Manifest: ${casesPath}`);
  if (validationError) {
    console.log(`Manifest validation error: ${validationError}`);
    failed++;
    failures.push({ runName: 'manifest-validation', reason: validationError });
    console.log('');
    console.log('=== Summary ===');
    console.log(`Cases: ${totalCases}`);
    console.log(`Failures: ${failed}`);
    cleanup();
    process.exit(1);
  }
  console.log('');

  // --- cases ---
  const cases = loadJson(casesPath);
  for (const c of cases) {
    const caseTmp = join(tmpRoot, 'case-' + c.name.replace(/[^a-zA-Z0-9._-]/g, '-'));
    const caseHome = join(caseTmp, 'home');
    mkdirSync(join(caseHome, '.claude'), { recursive: true });
    mkdirSync(caseTmp, { recursive: true });
    const ctx = { caseTmp, caseHome, sessionId: null };
    try {
      executeEntry(c.name, c, ctx, deltas.get(c.name));
    } catch (e) {
      recordFail(c.name, `runner exception: ${e.message}`);
    }
  }

  // --- scenarios ---
  console.log('');
  console.log('=== Hook Scenario Tests (Node runner) ===');
  console.log(`Manifest: ${scenariosPath}`);
  console.log('');
  const scenarios = loadJson(scenariosPath);
  for (const scen of scenarios) {
    totalScenarios++;
    const scenarioTmp = join(tmpRoot, 'scen-' + scen.name.replace(/[^a-zA-Z0-9._-]/g, '-'));
    const scenarioHome = join(scenarioTmp, 'home');
    mkdirSync(join(scenarioHome, '.claude'), { recursive: true });
    mkdirSync(scenarioTmp, { recursive: true });
    const sessionId = scen.session_id;
    const dataRoot = join(scenarioHome, '.claude');
    if (scen.seed_state) {
      try { seedState(dataRoot, sessionId, loadJson(resolveFsPath(scen.seed_state, scenarioTmp, scenarioHome))); }
      catch (e) { recordFail(`${scen.name}::seed`, `seed_state error: ${e.message}`); continue; }
    }
    for (const step of scen.steps) {
      const runName = `${scen.name}::${step.name}`;
      const ctx = { caseTmp: scenarioTmp, caseHome: scenarioHome, sessionId };
      try {
        executeEntry(runName, step, ctx, deltas.get(runName));
      } catch (e) {
        recordFail(runName, `runner exception: ${e.message}`);
      }
    }
  }

  console.log('');
  console.log('=== Summary ===');
  console.log(`Cases: ${totalCases}`);
  console.log(`Scenarios: ${totalScenarios}`);
  if (failed === 0) {
    console.log('All hook behavior + scenario tests passed!');
    cleanup();
    process.exit(0);
  }
  console.log(`Failures: ${failed}`);
  for (const f of failures) console.log(`  - ${f.runName}: ${f.reason}`);
  cleanup();
  process.exit(1);
}

// Run only when invoked as a script, so importing this module for unit tests
// of evalJq/jqAssert does not trigger main() (which calls process.exit).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`test-hooks fatal: ${err?.stack ?? err}\n`);
    cleanup();
    process.exit(1);
  });
}