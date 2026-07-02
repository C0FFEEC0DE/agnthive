// Node ESM port of scripts/bench_runner_claude_code.py.
//
// Invoked by run-benchmark.mjs with stdio:'inherit' and a benchmark env (no CLI
// args). Reads env vars: BENCH_TASK_FILE, BENCH_TASK_ID, BENCH_OUTPUT_DIR (writes
// result.json + claude-result.json + summary files here), BENCH_WORKDIR (cwd for
// `claude`), BENCH_FIXTURE_DIR, BENCH_REPO_ROOT, plus OLLAMA_MODEL,
// CLAUDE_CODE_MAX_OUTPUT_TOKENS, ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY,
// BENCH_CLAUDE_PROFILE_DIR, CLAUDE_BIN, MAX_TURNS, CLAUDE_TIMEOUT_SECONDS.
//
// Node standard library only. No child_process.exec, no shell:true, no npm deps.
// `claude` is spawned via spawnSync with an explicit argv array (no shell).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { join, resolve, relative, basename, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath as _fileURLToPath } from 'node:url';
import process from 'node:process';

// ---------- env helpers ----------
function envOrDefault(name, defaultValue) {
  const value = (process.env[name] || '').trim();
  return value || defaultValue;
}

const REPO_ROOT = process.env.BENCH_REPO_ROOT ? resolve(process.env.BENCH_REPO_ROOT) : '';
const TASK_FILE = process.env.BENCH_TASK_FILE ? resolve(process.env.BENCH_TASK_FILE) : '';
const WORKDIR = process.env.BENCH_WORKDIR ? resolve(process.env.BENCH_WORKDIR) : '';
const OUTPUT_DIR = process.env.BENCH_OUTPUT_DIR ? resolve(process.env.BENCH_OUTPUT_DIR) : '';

// The agent-hive plugin is the single source of truth for agent
// aliases and agent frontmatter (the legacy claudecfg/ tree was removed).
const PLUGIN_DIR = REPO_ROOT
  ? join(REPO_ROOT, 'plugins', 'agent-hive')
  : '';
const ALIASES_JSON = REPO_ROOT
  ? join(REPO_ROOT, 'plugins', 'agent-hive', 'assets', 'aliases.json')
  : '';
const AGENTS_DIR = REPO_ROOT
  ? join(REPO_ROOT, 'plugins', 'agent-hive', 'agents')
  : '';

const CLAUDE_BIN = envOrDefault('CLAUDE_BIN', 'claude');
const MODEL_NAME = envOrDefault('OLLAMA_MODEL', '');
const MAX_TURNS = envOrDefault('MAX_TURNS', '16');
const CLAUDE_TIMEOUT_SECONDS = Number(envOrDefault('CLAUDE_TIMEOUT_SECONDS', '300'));
const CLAUDE_CODE_MAX_OUTPUT_TOKENS = envOrDefault('CLAUDE_CODE_MAX_OUTPUT_TOKENS', '');

const OUTPUT_TOKEN_BUDGET_RETRIES = 3;
const PROVIDER_ERROR_RETRIES = 2;
const OLLAMA_429_MAX_RETRIES = 4;
const OLLAMA_429_BASE_DELAY = 8;
const SUMMARY_REPAIR_MAX_RETRIES = 5;
const SUMMARY_REPAIR_MAX_TURNS = '4';
const REQUIRED_SUMMARY_PREFIXES = [
  'Verification status:',
  'Review outcome:',
  'Remaining risks:',
];

// ---------- aliases / agent label map ----------
function loadAliasesJson(repoRoot) {
  const mapping = {};
  const aliasesPath = join(repoRoot, 'plugins', 'agent-hive', 'assets', 'aliases.json');
  if (existsSync(aliasesPath)) {
    const data = JSON.parse(readFileSync(aliasesPath, 'utf-8'));
    for (const [canonical, variants] of Object.entries(data)) {
      for (const variant of variants) mapping[variant] = canonical;
    }
  } else {
    // Fallback for benchmark unit tests that run with a dummy repo root.
    Object.assign(mapping, {
      a: 'a', architect: 'a', 'the-architect': 'a', design: 'a', plan: 'a',
      e: 'e', explorer: 'e', explore: 'e', nerd: 'e',
      bug: 'bug', bugbuster: 'bug', 'bug-pattern-hunter': 'bug', 'bug-pattern': 'bug',
      dbg: 'dbg', debugger: 'dbg', 'debugging-specialist': 'dbg',
      t: 't', tester: 't', testing: 't', paranoid: 't',
      cr: 'cr', 'code-reviewer': 'cr', 'code-review': 'cr', reviewer: 'cr', 'toxic-senior': 'cr',
      doc: 'doc', docwriter: 'doc', 'documentation-writer': 'doc', 'docs-writer': 'doc', docs: 'doc',
      m: 'm', manager: 'm', 'big-boss': 'm',
    });
  }
  return mapping;
}

function taskPathForOutput(taskFile, repoRoot) {
  try {
    const rel = relative(repoRoot, taskFile);
    if (rel && !rel.startsWith('..')) return rel.split(sep).join('/');
    return basename(taskFile);
  } catch {
    return basename(taskFile);
  }
}

const TASK_PATH = TASK_FILE && REPO_ROOT ? taskPathForOutput(TASK_FILE, REPO_ROOT) : '';

export function normalizeSubagentKey(raw) {
  if (!raw) return '';
  let s = String(raw).trim().replace(/^@+/, '').toLowerCase().replace(/_/g, '-').replace(/ /g, '-');
  s = s.replace(/[^a-z0-9.-]+/g, '-');
  s = s.replace(/-+/g, '-');
  return s.replace(/^[.-]+|[.-]+$/g, '');
}

export function frontmatterField(path, field) {
  const text = readFileSync(path, 'utf-8');
  return frontmatterFieldFromText(text, field);
}

export function frontmatterFieldFromText(text, field) {
  if (!text.startsWith('---\n')) return null;
  const re = new RegExp(`^${escapeRegex(field)}:\\s*(.+)$`, 'm');
  const m = re.exec(text);
  if (!m) return null;
  return m[1].trim();
}

function globDirMd(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    if (ent.isFile() && ent.name.endsWith('.md')) out.push(join(dir, ent.name));
  }
  return out.sort();
}

export function buildAgentLabelMap(repoRoot) {
  const mapping = { ...loadAliasesJson(repoRoot) };
  const agentsDir = join(repoRoot, 'plugins', 'agent-hive', 'agents');
  for (const path of globDirMd(agentsDir)) {
    const alias = frontmatterField(path, 'alias');
    if (!alias) continue;
    const stem = basename(path).replace(/\.md$/, '');
    const candidates = [
      alias,
      stem,
      frontmatterField(path, 'name'),
      frontmatterField(path, 'type'),
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const normalized = normalizeSubagentKey(candidate);
      if (normalized) mapping[normalized] = alias;
    }
  }
  return mapping;
}

let _LABEL_MAP = null;
function getLabelMap() {
  if (_LABEL_MAP) return _LABEL_MAP;
  _LABEL_MAP = REPO_ROOT ? buildAgentLabelMap(REPO_ROOT) : {};
  return _LABEL_MAP;
}

export function canonicalizeSubagentLabel(raw, labelMap = null) {
  const map = labelMap || getLabelMap();
  const normalized = normalizeSubagentKey(raw);
  if (!normalized) return null;
  const alias = map[normalized];
  if (alias) return alias;
  const values = new Set(Object.values(map));
  return values.has(normalized) ? normalized : null;
}

export function normalizeRequiredUsedAgent(raw, labelMap = null) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const alias = canonicalizeSubagentLabel(raw, labelMap);
  if (alias) return alias;
  const normalized = normalizeSubagentKey(raw);
  return normalized || null;
}

// ---------- docs / runtime path predicates ----------
export function isDocsPath(pathStr) {
  const lower = String(pathStr).toLowerCase();
  const name = basename(lower);
  return (
    /\.(md|mdx|txt|rst|adoc|markdown)$/.test(lower) ||
    lower.includes('/docs/') ||
    name.startsWith('readme') ||
    name.startsWith('changelog') ||
    name === 'claude.md'
  );
}

export function isIgnoredRuntimePath(p) {
  const ignoredParts = new Set(['__pycache__', 'node_modules', '.git']);
  const parts = p.split(sep);
  if (parts.some((part) => ignoredParts.has(part))) return true;
  return basename(p) === '.coverage';
}

// ---------- file snapshotting ----------
function snapshotFile(path) {
  const data = readFileSync(path);
  const digest = createHash('sha256').update(data).digest('hex');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return { kind: 'binary', sha256: digest, size: data.length };
  }
  return { kind: 'text', sha256: digest, size: data.length, text };
}

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, out);
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

export function snapshotFiles(root) {
  const snapshot = {};
  for (const path of walkFiles(root).sort()) {
    const rel = relative(root, path).split(sep).join('/');
    if (isIgnoredRuntimePath(rel)) continue;
    snapshot[rel] = snapshotFile(path);
  }
  return snapshot;
}

// ---------- unified diff (replaces Python difflib.unified_diff) ----------
function lcsOpcodes(a, b) {
  // Build LCS table, then emit opcodes: equal / replace / delete / insert.
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      if (ops.length && ops[ops.length - 1].tag === 'equal') ops[ops.length - 1].i2++;
      else ops.push({ tag: 'equal', i1: i, i2: i + 1, j1: j, j2: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      if (ops.length && (ops[ops.length - 1].tag === 'delete' || ops[ops.length - 1].tag === 'replace')) {
        const last = ops[ops.length - 1];
        if (last.tag === 'delete') last.i2++;
        else { last.i2++; last.j2 = last.j2; }
      } else {
        ops.push({ tag: 'delete', i1: i, i2: i + 1, j1: j, j2: j });
      }
      i++;
    } else {
      if (ops.length && ops[ops.length - 1].tag === 'insert') ops[ops.length - 1].j2++;
      else ops.push({ tag: 'insert', i1: i, i2: i, j1: j, j2: j + 1 });
      j++;
    }
  }
  while (i < n) {
    if (ops.length && ops[ops.length - 1].tag === 'delete') ops[ops.length - 1].i2++;
    else ops.push({ tag: 'delete', i1: i, i2: i + 1, j1: j, j2: j });
    i++;
  }
  while (j < m) {
    if (ops.length && ops[ops.length - 1].tag === 'insert') ops[ops.length - 1].j2++;
    else ops.push({ tag: 'insert', i1: i, i2: i, j1: j, j2: j + 1 });
    j++;
  }
  // Merge adjacent delete+insert into replace for cleaner hunks.
  const merged = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && last.tag === 'delete' && op.tag === 'insert') {
      merged[merged.length - 1] = { tag: 'replace', i1: last.i1, i2: last.i2, j1: last.j1, j2: op.j2 };
    } else if (last && last.tag === 'insert' && op.tag === 'delete') {
      merged[merged.length - 1] = { tag: 'replace', i1: op.i1, i2: op.i2, j1: last.j1, j2: last.j2 };
    } else {
      merged.push({ ...op });
    }
  }
  return merged;
}

function formatRangeUnified(start, stop) {
  const beginning = start + 1; // lines start numbering with one
  const length = stop - start;
  if (length === 1) return String(beginning);
  if (length === 0) return `${beginning - 1},0`;
  return `${beginning},${length}`;
}

export function buildPatch(before, after) {
  const chunks = [];
  for (const relPath of sortedUnion(Object.keys(before), Object.keys(after))) {
    const old = before[relPath];
    const nw = after[relPath];
    if (deepEqual(old, nw)) continue;
    const oldKind = old ? old.kind : null;
    const newKind = nw ? nw.kind : null;
    if ((old && oldKind !== 'text') || (nw && newKind !== 'text')) {
      chunks.push(`Binary files differ: ${relPath}\n`);
      continue;
    }
    const oldText = old ? String(old.text || '') : '';
    const newText = nw ? String(nw.text || '') : '';
    const oldLines = splitKeepEnds(oldText);
    const newLines = splitKeepEnds(newText);
    const diffLines = unifiedDiff(oldLines, newLines, `a/${relPath}`, `b/${relPath}`, 3);
    for (const line of diffLines) chunks.push(line);
  }
  return chunks.join('');
}

function splitKeepEnds(text) {
  if (!text) return [];
  const out = [];
  const re = /.*?(?:\r\n|\n|\r|$)/gs;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '') break;
    out.push(m[0]);
    if (m[0].length === 0 || (re.lastIndex === text.length && !/[\r\n]$/.test(m[0]))) break;
  }
  return out;
}

function unifiedDiff(a, b, fromfile, tofile, context) {
  const ops = lcsOpcodes(a, b);
  if (!ops.length) return [];
  // Group opcodes: split at equal runs longer than 2*context.
  const nn = context * 2;
  const groups = [];
  let group = [];
  // Trim leading equal.
  if (ops[0].tag === 'equal') {
    const first = ops[0];
    const i2 = Math.min(first.i2, first.i1 + context);
    ops[0] = { tag: 'equal', i1: first.i1, i2, j1: first.j1, j2: first.j1 + (i2 - first.i1) };
  }
  if (ops[ops.length - 1].tag === 'equal') {
    const last = ops[ops.length - 1];
    const i1 = Math.max(last.i1, last.i2 - context);
    ops[ops.length - 1] = { tag: 'equal', i1, i2: last.i2, j1: last.j1 + (i1 - last.i1), j2: last.j2 };
  }
  for (const op of ops) {
    if (op.tag === 'equal' && op.i2 - op.i1 > nn) {
      group.push({ tag: 'equal', i1: op.i1, i2: Math.min(op.i2, op.i1 + context), j1: op.j1, j2: Math.min(op.j2, op.j1 + context) });
      groups.push(group);
      group = [];
      const ni1 = Math.max(op.i1, op.i2 - context);
      const nj1 = Math.max(op.j1, op.j2 - context);
      group.push({ tag: 'equal', i1: ni1, i2: op.i2, j1: nj1, j2: op.j2 });
    } else {
      group.push(op);
    }
  }
  if (group.length && group.some((op) => op.tag !== 'equal')) groups.push(group);

  const out = [];
  out.push(`--- ${fromfile}\n`);
  out.push(`+++ ${tofile}\n`);
  for (const grp of groups) {
    const first = grp[0];
    const last = grp[grp.length - 1];
    const aStart = first.i1;
    const aEnd = last.i2;
    const bStart = first.j1;
    const bEnd = last.j2;
    out.push(`@@ -${formatRangeUnified(aStart, aEnd)} +${formatRangeUnified(bStart, bEnd)} @@\n`);
    for (const op of grp) {
      if (op.tag === 'equal') {
        for (let k = op.i1; k < op.i2; k++) out.push(' ' + a[k]);
      } else if (op.tag === 'replace') {
        for (let k = op.i1; k < op.i2; k++) out.push('-' + a[k]);
        for (let k = op.j1; k < op.j2; k++) out.push('+' + b[k]);
      } else if (op.tag === 'delete') {
        for (let k = op.i1; k < op.i2; k++) out.push('-' + a[k]);
      } else if (op.tag === 'insert') {
        for (let k = op.j1; k < op.j2; k++) out.push('+' + b[k]);
      }
    }
  }
  return out;
}

function sortedUnion(a, b) {
  const set = new Set([...a, ...b]);
  return [...set].sort();
}

function deepEqual(x, y) {
  return JSON.stringify(x) === JSON.stringify(y);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build the machine-readable dispatch-contract marker injected into the ROOT
// benchmark prompt only. The plugin's UserPromptSubmit classifier parses this
// (workflow.mjs parseDispatchContractMarker) so a tiny task can require exactly
// the listed specialist(s) instead of the category-default role set. Root-only
// by construction: buildPrompt runs once for the root prompt, never for a
// subagent, so a specialist cannot recursively re-dispatch itself.
export function dispatchContractMarker(task) {
  const c = task?.dispatch_contract;
  if (!c) return '';
  const mode = c.mode;
  if (mode !== 'observed' && mode !== 'enforced' && mode !== 'standard') return '';
  const roles = Array.isArray(c.required_agents)
    ? c.required_agents.filter((a) => typeof a === 'string' && a).map((a) => String(a).toLowerCase())
    : [];
  if (!roles.length) return '';
  const rootOnly = c.root_only === false ? '' : 'root_only; ';
  return `BENCHMARK_DISPATCH_CONTRACT: ${rootOnly}mode=${mode}; roles=${roles.join(',')}`;
}

// ---------- prompt builder ----------
export function buildPrompt(task, verificationLabel) {
  const successCriteria = (task.success_criteria || []).map((i) => `- ${i}`).join('\n');
  const mustNot = (task.must_not || []).map((i) => `- ${i}`).join('\n');
  const category = String(task.category);
  const verificationHint =
    task.verification_required && verificationLabel !== 'verification'
      ? `If verification is required, run the relevant tests locally (${verificationLabel}).`
      : 'If verification is required, run the relevant tests locally.';
  const workflowOverride =
    `Workflow override: treat this as a ${category} workflow, not a review-only workflow. ` +
    'Implementation and file edits are in scope when the task asks for them. ' +
    'Do not reinterpret this as a review task just because the final summary must include review outcome.';
  const dispatchContractBlock = dispatchContractMarker(task);
  const dispatchContractNote = dispatchContractBlock
    ? '\n\nDispatch contract discipline:\n'
      + '- Your first substantive action must be launching the required specialist via the Agent tool (a real SubagentStart).\n'
      + '- Do not Edit, Write, or MultiEdit any file before that specialist has started.\n'
      + '- The specialist owns the substantive work; you coordinate, verify, and report.'
    : '';
  const executionDisciplineNote =
    'Keep the run terse and execution-first. ' +
    'Start the first required handoff immediately, avoid filler planning prose, and spend turns on edits, tests, and required specialist handoffs.';
  const fixtureLayoutNote =
    'Preserve the existing fixture layout. ' +
    'Modify existing files in place when they already exist. ' +
    'Do not rename, relocate, or duplicate source or test files unless the task explicitly requires it. ' +
    'If the fixture already contains a test file, update that file instead of creating a second copy under a new path.';
  const requiredUsedAgentList = (task.required_used_agents || []).filter(
    (alias) => typeof alias === 'string',
  );
  const requiredUsedAgents = requiredUsedAgentList.map((alias) => `@${alias}`).join(', ');
  const requiredTranscriptHints = transcriptContractHints(task);
  let requiredUsedAgentNote = '';
  if (requiredUsedAgents) {
    let completionDisciplineNote = '';
    let sequenceNote = '';
    let ownershipNote = '';
    if (requiredUsedAgentList.length > 1) {
      const ordered = requiredUsedAgentList.map((a) => `@${a}`).join(' -> ');
      sequenceNote =
        `\n- Every required role must be launched as a real handoff in this order: ${ordered}\n` +
        '- A prose summary that claims a handoff happened does not count as the handoff itself.';
      if (requiredUsedAgentList[0] === 'm' && requiredUsedAgentList.length > 1) {
        const downstream = requiredUsedAgentList.slice(1).map((a) => `@${a}`).join(' -> ');
        sequenceNote +=
          `\n- For this manager-led run, launch @m first. Then the manager must launch the remaining required roles in order: ${downstream}.`;
      }
    }
    if (requiredUsedAgentList[requiredUsedAgentList.length - 1] === 'cr') {
      completionDisciplineNote =
        '\n- If @cr is the final required role, reserve time for it: once verification and docs are ready, launch @cr immediately.\n' +
        '- Keep the @cr review terse and findings-only so the required review handoff lands before timeout.\n' +
        '- Do not spend the final turns polishing prose or making optional edits before the required @cr handoff.';
    }
    if (requiredUsedAgentList.length === 1) {
      const requiredAlias = `@${requiredUsedAgentList[0]}`;
      ownershipNote =
        `\n- This task has a single required specialist. Launch ${requiredAlias} first and let that specialist own the core task.\n` +
        `- Do not make the substantive edit or analysis yourself before ${requiredAlias} is launched; that still fails the run even if tests pass.`;
    }
    requiredUsedAgentNote =
      `\n\nRequired specialist handoff:\n` +
      '- This run is scored on a real specialist launch, not a prose mention.\n' +
      `- Start with an actual handoff to: ${requiredUsedAgents}\n` +
      `- Make that handoff before doing the substantive work yourself.${sequenceNote}${ownershipNote}${completionDisciplineNote}\n` +
      `- Before the required footer, report the completed real handoff as: Handoff evidence: ${requiredUsedAgents} <what the specialist did>.`;
    requiredUsedAgentNote +=
      '\n- Prefer direct alias handoffs like @doc, @a, or @cr instead of slash skills such as /docs, /design, or /review unless the task explicitly asks for the slash command.\n' +
      '- Do not burn turns probing avoidable skill path/tool restrictions before the required alias handoff lands.';
  }
  let transcriptContractNote = '';
  if (requiredTranscriptHints.length) {
    transcriptContractNote =
      '\n\nTranscript contract:\n' +
      '- The assistant-visible handoff/final response must include these exact labels somewhere in the transcript:\n' +
      requiredTranscriptHints.map((h) => `- ${h}`).join('\n') +
      '\n- Do not replace these labels with markdown section titles or synonyms.';
  }

  return `You are running in a tiny benchmark repository fixture.

Complete the task in the current working directory using the agent-hive Claude Code plugin (loaded via --plugin-dir).
Use tools normally. Make only the changes needed for this task. Do not do release or deploy work.
If behavior changes, update docs. ${verificationHint}
Leave the workspace changes in place for artifact collection.
${executionDisciplineNote}
${fixtureLayoutNote}

${workflowOverride}
${dispatchContractBlock}
Task metadata:
- id: ${task.id}
- workflow_category: ${category}
- review_required: ${JSON.stringify(Boolean(task.review_required))}
- docs_required: ${JSON.stringify(Boolean(task.docs_required))}
- verification_required: ${JSON.stringify(Boolean(task.verification_required))}

Task:
${task.prompt}

Success criteria:
${successCriteria || '- none provided'}

Must not:
${mustNot || '- none provided'}

Final response requirements:
- Keep it concise.
- Your final response MUST end with exactly this 3-line footer.
- Do not rename the prefixes.
- Do not omit any footer line.
- Do not add any text after the footer.

Required footer template:
Verification status: <passed|failed|not run|not required> - <one sentence>
Review outcome: <done|pending|not required> - <one sentence>
Remaining risks: <one sentence or "none">

Example footer:
Verification status: passed - ${verificationLabel} completed successfully.
Review outcome: done - changes were reviewed before completion.
Remaining risks: none
${requiredUsedAgentNote}${transcriptContractNote}${dispatchContractNote}
`;
}

// ---------- retry predicates ----------
export function isOllama429(text) {
  if (!text) return false;
  const lowered = String(text).toLowerCase();
  return lowered.includes('429') || (lowered.includes('rate') && lowered.includes('limit'));
}

export function parseAffordableMaxTokens(text) {
  const m = /requested up to\s+(\d+)\s+tokens,\s+but can only afford\s+(\d+)/i.exec(String(text));
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

export function adjustedOutputTokenBudget(affordableTokens) {
  if (affordableTokens <= 0) return null;
  return Math.max(256, affordableTokens - Math.min(128, Math.max(1, Math.floor(affordableTokens / 10))));
}

export function isRetryableProviderError(text) {
  const lowered = String(text).toLowerCase();
  if (lowered.includes('api error: 403') && lowered.includes('daily limit')) return false;
  if (lowered.includes('429') || lowered.includes('rate limit')) return true;
  const retryableMarkers = [
    'provider returned error',
    'internalerror.algo.invalidparameter',
    'tool_call_ids did not have response messages',
    'invalid_parameter_error',
  ];
  return retryableMarkers.some((marker) => lowered.includes(marker));
}

// ---------- claude JSON / result text ----------
export function extractResultPayload(rawJson) {
  if (!String(rawJson).trim()) return null;
  try {
    const payload = JSON.parse(rawJson);
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function extractResultText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return String(payload.result || '');
}

export function safeSessionId(raw) {
  if (!raw) return 'no-session';
  return String(raw).replace(/[^A-Za-z0-9._-]/g, '_');
}

function stateFileForSession(sessionId) {
  return join(homedir(), '.claude', 'state', `${safeSessionId(sessionId)}.json`);
}

export function resolveTranscriptPath(payload) {
  if (payload && typeof payload === 'object') {
    const direct = String(payload.transcript_path || '').trim();
    if (direct) return direct;
    const sessionId = String(payload.session_id || '').trim();
    if (sessionId) {
      const stateFile = stateFileForSession(sessionId);
      if (existsSync(stateFile)) {
        try {
          const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
          const transcriptPath = String(state.transcript_path || '').trim();
          if (transcriptPath) return transcriptPath;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function flattenMessageText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  const chunks = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const text = item.text;
    if (typeof text === 'string' && text.trim()) {
      chunks.push(text);
      continue;
    }
    const content = item.content;
    if (typeof content === 'string' && content.trim()) chunks.push(content);
  }
  return chunks.join('\n');
}

export function transcriptCandidateText(event) {
  const candidates = [
    event.last_assistant_message,
    event.result,
    event.text,
  ];
  const message = event.message;
  if (message && typeof message === 'object') {
    candidates.push(flattenMessageText(message.content));
    const text = message.text;
    if (typeof text === 'string') candidates.push(text);
  }
  candidates.push(flattenMessageText(event.content));
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

export function hasLinePrefix(text, prefix) {
  const re = new RegExp('^\\s*' + escapeRegex(prefix), 'im');
  return re.test(String(text));
}

export function transcriptCandidateScore(text) {
  let score = 0;
  const lowered = String(text).toLowerCase();
  if (hasLinePrefix(text, 'Verification status:')) score += 4;
  if (hasLinePrefix(text, 'Review outcome:')) score += 4;
  if (hasLinePrefix(text, 'Remaining risks:')) score += 4;
  if (lowered.includes('verification') || lowered.includes('node --test') || lowered.includes('test')) score += 1;
  if (lowered.includes('review')) score += 1;
  if (lowered.includes('risk')) score += 1;
  return score;
}

export function extractResultTextFromTranscript(payload) {
  const transcriptPath = resolveTranscriptPath(payload);
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  let bestText = '';
  let bestScore = -1;
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return '';
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    const text = transcriptCandidateText(event);
    if (!text) continue;
    const score = transcriptCandidateScore(text);
    if (score > bestScore || (score === bestScore && score > 0)) {
      bestText = text;
      bestScore = score;
    }
  }
  return bestScore > 0 ? bestText : '';
}

// ---------- transcript pattern / agent inference ----------
function isAssistantLikeTranscriptEvent(event) {
  const eventType = String(event.type || '').trim().toLowerCase();
  if (eventType === 'assistant' || eventType === 'result') return true;
  const message = event.message;
  if (message && typeof message === 'object') {
    const role = String(message.role || '').trim().toLowerCase();
    if (role === 'assistant') return true;
  }
  return false;
}

function transcriptTextEntries(payload, { assistantOnly = false } = {}) {
  const transcriptPath = resolveTranscriptPath(payload);
  if (!transcriptPath || !existsSync(transcriptPath)) return [false, []];
  const entries = [];
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return [false, []];
  }
  const lines = raw.split('\n');
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    if (assistantOnly && !isAssistantLikeTranscriptEvent(event)) continue;
    const text = transcriptCandidateText(event);
    if (!text) continue;
    entries.push([`${basename(transcriptPath)}:${idx + 1}`, text.trim()]);
  }
  return [true, entries];
}

function assistantPatternEntries(payload, { resultText = '' } = {}) {
  const [scanned, entries] = transcriptTextEntries(payload, { assistantOnly: true });
  const supplemental = resultText.trim();
  if (supplemental && !entries.some(([, text]) => text.trim() === supplemental)) {
    entries.push(['claude-result.txt', supplemental]);
    return [true, entries];
  }
  return [scanned, entries];
}

export function forbiddenTranscriptPatternHits(task, payload, { resultText = '' } = {}) {
  const patterns = task.forbidden_transcript_patterns;
  if (!Array.isArray(patterns) || !patterns.length) return [false, []];
  const [scanned, entries] = assistantPatternEntries(payload, { resultText });
  if (!scanned) return [false, []];
  const hits = [];
  for (const [source, text] of entries) {
    for (const pattern of patterns) {
      if (typeof pattern !== 'string' || !pattern.trim()) continue;
      const re = new RegExp(pattern, 'im');
      if (re.test(text)) hits.push(`${source}: /${pattern}/ -> ${truncate(text, 200)}`);
    }
  }
  return [true, hits];
}

export function requiredTranscriptPatternMisses(task, payload, { resultText = '' } = {}) {
  const patterns = task.required_transcript_patterns;
  if (!Array.isArray(patterns) || !patterns.length) return [false, []];
  const [scanned, entries] = assistantPatternEntries(payload, { resultText });
  if (!scanned) return [false, ['<assistant transcript unavailable>']];
  const misses = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern.trim()) continue;
    if (!entries.some(([, text]) => new RegExp(pattern, 'im').test(text))) misses.push(pattern);
  }
  return [true, misses];
}

export function effectiveRequiredTranscriptMisses(misses, { recoveredNonzeroExit = false } = {}) {
  if (recoveredNonzeroExit && misses.length === 1 && misses[0] === '<assistant transcript unavailable>') return [];
  return misses;
}

export function inferUsedAgentAliasesFromTranscript(payload, labelMap) {
  const [scanned, entries] = transcriptTextEntries(payload);
  if (!scanned) return [];
  const text = entries.map(([, e]) => e).join('\n').toLowerCase();
  const detections = [
    ['m', /skill\(\/manager\)/],
    ['cr', /skill\(\/review\)/],
    ['t', /skill\(\/test\)/],
    ['e', /skill\(\/explore\)/],
    ['a', /skill\(\/design\)/],
    ['bug', /skill\(\/bug\)/],
    ['dbg', /skill\(\/debug\)/],
    ['doc', /skill\(\/docs\)/],
    ['a', /skill\(\/refactor\)/],
    ['m', /(^|[\s])manager\(/],
    ['cr', /(^|[\s])code reviewer\(/],
    ['t', /(^|[\s])tester\(/],
    ['e', /(^|[\s])explorer\(/],
    ['a', /(^|[\s])architect\(/],
    ['bug', /(^|[\s])bugbuster\(/],
    ['dbg', /(^|[\s])debugger\(/],
    ['doc', /(^|[\s])docwriter\(/],
  ];
  const aliases = [];
  const seen = new Set();
  for (const [alias, pattern] of detections) {
    if (!seen.has(alias) && new RegExp(pattern, 'im').test(text)) {
      seen.add(alias);
      aliases.push(alias);
    }
  }
  const aliasPattern = /@(m|e|a|t|cr|bug|dbg|doc|manager|explorer|architect|tester|code-reviewer|code-review|reviewer|bugbuster|debugger|docwriter|big-boss|nerd|toxic-senior|paranoid|the-architect|wiki-wiki)(?:$|[^a-z0-9-])/gi;
  let m;
  while ((m = aliasPattern.exec(text)) !== null) {
    const rawLabel = m[1];
    const alias = canonicalizeSubagentLabel(rawLabel, labelMap);
    if (alias && !seen.has(alias)) {
      seen.add(alias);
      aliases.push(alias);
    }
  }
  return aliases;
}

function inferUsedAgentAliasesFromResultText(resultText, labelMap) {
  const text = String(resultText).trim();
  if (!text) return [];
  const aliases = [];
  const seen = new Set();
  const patterns = [
    /^\s*Handoff evidence:\s*@([A-Za-z0-9_-]+)\b/im,
    /^\s*[-*]\s*(?:\*\*)?@([A-Za-z0-9_-]+)(?:\*\*)?\b/im,
    /\b(?:handoff|handoffs|launch|launched|delegate|delegated|delegation)\b[^@\n]*@([A-Za-z0-9_-]+)\b/im,
    /\B@([A-Za-z0-9_-]+)\b\s+(?:reviewed|verified|implemented|fixed|documented|analyzed|mapped|confirmed|approved|identified|added|scoped|executed|reproduced|coordinated)\b/im,
    /\b(?:via|per)\s+@([A-Za-z0-9_-]+)\s+handoff\b/im,
  ];
  for (const pattern of patterns) {
    let m;
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    while ((m = re.exec(text)) !== null) {
      const rawLabel = m[1];
      const alias = canonicalizeSubagentLabel(rawLabel, labelMap);
      if (alias && !seen.has(alias)) {
        seen.add(alias);
        aliases.push(alias);
      }
    }
  }
  return aliases;
}

// Aliases backed by a real SubagentStart hook event (or its Recorded subagent
// handoff echo) captured in the debug log. Only these satisfy a strict
// observed-dispatch contract; prose claims and transcript launch-text do not.
function hookSourceAliases(debugLogText, labelMap = null) {
  const aliases = [];
  const seen = new Set();
  const patterns = [
    /Hook SubagentStart:([^\(\n\"]+)/,
    /Recorded subagent handoff:\s*@([A-Za-z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, 'g');
    let m;
    while ((m = re.exec(debugLogText || '')) !== null) {
      const alias = canonicalizeSubagentLabel(m[1], labelMap);
      if (alias && !seen.has(alias)) {
        seen.add(alias);
        aliases.push(alias);
      }
    }
  }
  return aliases;
}

export function extractUsedAgentAliases(debugLogText, payload = null, { resultText = '' } = {}, labelMap = null) {
  const hook = hookSourceAliases(debugLogText, labelMap);
  const seen = new Set(hook);
  const aliases = hook.slice();
  for (const alias of inferUsedAgentAliasesFromTranscript(payload, labelMap)) {
    if (!seen.has(alias)) {
      seen.add(alias);
      aliases.push(alias);
    }
  }
  for (const alias of inferUsedAgentAliasesFromResultText(resultText, labelMap)) {
    if (!seen.has(alias)) {
      seen.add(alias);
      aliases.push(alias);
    }
  }
  return aliases;
}

// Split agent-usage evidence into disjoint sources so a strict observed
// dispatch contract can be enforced against real SubagentStart events while
// keeping prose "Handoff evidence:" claims and transcript launch-text as
// diagnostics only.
//   hook       — SubagentStart / Recorded subagent handoff (real dispatch)
//   transcript — launch-like lines inferred from the structured transcript
//   claimed    — "Handoff evidence: @…" or prose in the final result text
// `byAlias` maps each alias to the source(s) it appeared in, for reporting.
export function extractUsedAgentEvidence(debugLogText, payload = null, { resultText = '' } = {}, labelMap = null) {
  const hook = hookSourceAliases(debugLogText, labelMap);
  const transcript = inferUsedAgentAliasesFromTranscript(payload, labelMap);
  const claimed = inferUsedAgentAliasesFromResultText(resultText, labelMap);
  const byAlias = {};
  for (const alias of new Set([...hook, ...transcript, ...claimed])) {
    byAlias[alias] = {
      hook: hook.includes(alias),
      transcript: transcript.includes(alias),
      claimed: claimed.includes(alias),
    };
  }
  return { hook, transcript, claimed, byAlias };
}

// Resolve the benchmark dispatch contract mode declared on a task.
//   'standard' — legacy: credited union of hook+transcript+claimed (default)
//   'observed' — strict: only a real SubagentStart counts as dispatch
//   'enforced' — hard harness guard forces dispatch (see Stage 5)
export function resolveDispatchMode(task) {
  const mode = task?.dispatch_contract?.mode;
  if (mode === 'enforced') return 'enforced';
  if (mode === 'observed') return 'observed';
  return 'standard';
}

// For observed/enforced dispatch modes, only a real SubagentStart (the hook
// source) counts toward satisfying required_used_agents; prose "Handoff
// evidence:" claims and transcript launch-text do not. Under standard mode the
// legacy union (hook + transcript + claimed) is still credited, preserving
// existing behavior for tasks without a dispatch_contract.
export function effectiveUsedAliasesForEnforcement(dispatchMode, usedAgentAliases, observedAgentAliases) {
  if (dispatchMode === 'observed' || dispatchMode === 'enforced') {
    return Array.isArray(observedAgentAliases) ? observedAgentAliases : [];
  }
  return Array.isArray(usedAgentAliases) ? usedAgentAliases : [];
}

export function transcriptContractHints(task) {
  const patterns = task.required_transcript_patterns;
  if (!Array.isArray(patterns)) return [];
  const hints = [];
  const seen = new Set();
  const replacements = [
    [/Task:\\s*Docs/, 'Task: Docs'],
    [/Task:\\s*Code Review/, 'Task: Code Review'],
    [/Task:\\s*Debug/, 'Task: Debug'],
    [/Task:\\s*Explore/, 'Task: Explore'],
    [/Task:\\s*Testing/, 'Task: Testing'],
    [/Task:\\s*Refactor/, 'Task: Refactor'],
    [/Task:\\s*Housekeeping/, 'Task: Housekeeping'],
    ['Coverage:', 'Coverage:'],
    ['Findings:|Investigation', 'Findings: or Investigation:'],
    ['Outcome:|Fix:', 'Outcome: or Fix:'],
    ['Changed files:|No files changed:', 'Changed files: or No files changed:'],
    ['Verification status:', 'Verification status:'],
    ['Review outcome:', 'Review outcome:'],
    ['Remaining risks:|Next step:', 'Remaining risks: or Next step:'],
    ['Locations:', 'Locations:'],
    ['Plan:', 'Plan:'],
    ['Reproduction:', 'Reproduction:'],
    ['Root cause:', 'Root cause:'],
    ['Warnings:', 'Warnings:'],
    ['Gaps:', 'Gaps:'],
  ];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern.trim()) continue;
    let hint = pattern.trim();
    for (const [source, replacement] of replacements) {
      let match = false;
      if (source instanceof RegExp) match = source.test(hint);
      else match = hint.includes(source);
      if (match) {
        hint = replacement;
        break;
      }
    }
    if (!seen.has(hint)) {
      seen.add(hint);
      hints.push(hint);
    }
  }
  return hints;
}

// ---------- verification ----------
export function detectVerificationTarget(workdir) {
  const packageJson = join(workdir, 'package.json');
  if (existsSync(packageJson)) {
    let packagePayload;
    try {
      packagePayload = JSON.parse(readFileSync(packageJson, 'utf-8'));
    } catch {
      return [null, null];
    }
    const scripts = packagePayload && typeof packagePayload === 'object' ? packagePayload.scripts : null;
    if (
      scripts &&
      typeof scripts === 'object' &&
      typeof scripts.test === 'string' &&
      scripts.test.trim()
    ) {
      return [['npm', 'run', 'test', '--silent'], 'npm run test'];
    }
  }
  if (existsSync(join(workdir, 'Cargo.toml'))) return [['cargo', 'test', '--quiet'], 'cargo test'];
  if (existsSync(join(workdir, 'go.mod'))) return [['go', 'test', './...'], 'go test ./...'];

  // Node --test: a Node test runner spec file at the top level or under tests/.
  // Node's test runner discovers *.test.mjs / test-*.mjs / test.mjs (and the .js
  // spellings) when invoked as `node --test` with no path arguments.
  const testsDir = join(workdir, 'tests');
  const hasNodeTests =
    globDirFiles(workdir, '*.test.mjs').length > 0 ||
    globDirFiles(workdir, 'test-*.mjs').length > 0 ||
    existsSync(join(workdir, 'test.mjs')) ||
    (existsSync(testsDir) && globDirFiles(testsDir, '*.mjs').length > 0);
  if (hasNodeTests) return [['node', '--test'], 'node --test'];

  return [null, null];
}

function globDirFiles(dir, pattern) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const re = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*') + '$');
  const out = [];
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    if (ent.isFile() && re.test(ent.name)) out.push(join(dir, ent.name));
  }
  return out;
}

let _spawnSync = spawnSync; // injectable for tests
export function __setSpawnSync(fn) {
  _spawnSync = fn || spawnSync;
}

export function runVerification(workdir) {
  const [command, verificationLabel] = detectVerificationTarget(workdir);
  if (command === null || verificationLabel === null) {
    return [
      false,
      false,
      'No supported automated verification target was found in the fixture.',
      'verification',
    ];
  }
  const completed = _spawnSync(command[0], command.slice(1), {
    cwd: workdir,
    encoding: 'utf-8',
  });
  const output = `${completed.stdout || ''}\n${completed.stderr || ''}`.trim();
  return [true, completed.status === 0, output, verificationLabel];
}

// ---------- summary / footer ----------
export function missingSummaryPrefixes(text) {
  return REQUIRED_SUMMARY_PREFIXES.filter((prefix) => !hasLinePrefix(text, prefix));
}

export function extractPrefixedLine(text, prefix) {
  const re = new RegExp('^\\s*' + escapeRegex(prefix) + '[^\\n]*', 'im');
  const m = re.exec(String(text));
  return m ? m[0].trim() : '';
}

export function mergeFooter(text, footerLines) {
  const bodyLines = [];
  for (const line of String(text).split('\n')) {
    const stripped = line.replace(/^\s+/, '');
    if (REQUIRED_SUMMARY_PREFIXES.some((p) => stripped.startsWith(p))) continue;
    bodyLines.push(line.replace(/\s+$/, ''));
  }
  const body = bodyLines.join('\n').trim();
  const footer = footerLines.join('\n').trim();
  if (body && footer) return `${body}\n\n${footer}`;
  return body || footer;
}

export function verificationStatusLine(verificationRequired, testsRun, testsPassed, verificationLabel) {
  if (!verificationRequired) return 'Verification status: not required - benchmark task did not require automated verification.';
  if (!testsRun) return 'Verification status: not run - required verification did not execute.';
  if (testsPassed) return `Verification status: passed - ${verificationLabel} completed successfully.`;
  return `Verification status: failed - ${verificationLabel} reported failures.`;
}

export function reviewOutcomeLine(reviewRequired, reviewPresent) {
  if (!reviewRequired) return 'Review outcome: not required - benchmark task did not require an explicit review summary.';
  if (reviewPresent) return 'Review outcome: done - explicit review summary is present.';
  return 'Review outcome: pending - the model omitted an explicit review summary.';
}

export function remainingRisksLine(verificationRequired, testsRun, testsPassed, reviewRequired) {
  if (verificationRequired && (!testsRun || !testsPassed)) return 'Remaining risks: automated verification is incomplete or failing.';
  if (reviewRequired) return 'Remaining risks: the model omitted explicit remaining-risk and review summaries.';
  return 'Remaining risks: none';
}

export function synthesizeFooter(args) {
  return [
    verificationStatusLine(args.verificationRequired, args.testsRun, args.testsPassed, args.verificationLabel),
    reviewOutcomeLine(args.reviewRequired, args.reviewPresent),
    remainingRisksLine(args.verificationRequired, args.testsRun, args.testsPassed, args.reviewRequired),
  ];
}

export function completedTaskRecoveryMode(args) {
  if (!args.completed) return 'none';
  if (args.verificationRequired && !(args.testsRun && args.testsPassed && args.verificationSummaryPresent)) return 'none';
  if (args.reviewRequired && !args.reviewPresent) return 'none';
  if (!args.risksPresent) return 'none';
  if (args.docsRequired && !args.docsUpdated) return 'none';
  if (args.category === 'docs' && args.nonDocChangedFiles.length) return 'none';
  if (args.docPatternHits.length) return 'none';
  if (args.exitCode === 124 && args.fatalError.startsWith('Claude timed out after ')) return 'timeout';
  if (args.payloadSubtype === 'error_max_turns') return 'max_turns';
  // The task fully completed and verified despite a lingering process-level
  // fatalError at exitCode 0. Two sub-cases reach here:
  //  (a) claude RAN and exited 0 but emitted empty/malformed stdout
  //      ("Claude output JSON is missing/invalid/empty") — the work was done
  //      (files changed) and verification passed, so this is a recovered
  //      reporting failure, not a functional failure.
  //  (b) spawnSync threw a non-timeout error before/without claude producing
  //      output (ENOENT/EACCES/... -> fatalError "Claude runner exception: ..."),
  //      exitCode stays 0. Recovering these is parity with the timeout/max_turns
  //      envelope; see Remaining-risks note on the exitCode-0 conflation.
  // (ERR_CHILD_PROCESS_STDIO_MAXBUFFER is NOT here: a maxBuffer kill sets
  // res.signal, so runClaude's timedOut clause raises TimeoutExpired -> exitCode
  // 124 -> recovered via the timeout branch above, not this one.)
  // Every completion/verification/review/docs guard above already passed, so the
  // fatalError is a recovered process error. Without this branch it would stay
  // in failures[] and merge-block the functional gate — the same bug class as
  // the recovered spawnSync timeout, on a path the timeout fix never touches.
  // (exitCode !== 0 is intentionally left unrecovered: a persistent nonzero
  // claude exit after retries is a stronger signal and stays conservative.)
  if (args.exitCode === 0 && args.fatalError) return 'runner_exception';
  return 'none';
}

export function buildSummaryRepairPrompt(args) {
  return `You already completed the benchmark task. Do not modify any files.

Return only the required 3-line footer and nothing else.
Use these prefixes exactly and keep exactly one line per prefix:
Verification status:
Review outcome:
Remaining risks:

Required footer format:
Verification status: <passed|failed|not run|not required> - <one sentence>
Review outcome: <done|pending|not required> - <one sentence>
Remaining risks: <one sentence or "none">

Known facts:
- task_id: ${args.task.id}
- verification_required: ${JSON.stringify(args.verificationRequired)}
- tests_run: ${JSON.stringify(args.testsRun)}
- tests_passed: ${JSON.stringify(args.testsPassed)}
- verification_label: ${JSON.stringify(args.verificationLabel)}
- review_required: ${JSON.stringify(args.reviewRequired)}
- changed_files: ${args.changedFiles.length ? args.changedFiles.join(', ') : 'none'}

Previous response excerpt:
${truncate(args.resultText, 1200) || '<missing>'}

Verification output excerpt:
${truncate(args.verificationOutput, 1200) || '<not run>'}
`;
}

export function truncate(text, limit = 1200) {
  const clean = String(text || '').trim();
  if ([...clean].length <= limit) return clean;
  return [...clean].slice(0, limit - 3).join('') + '...';
}

function writeText(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

function payloadKeys(payload) {
  if (!payload || typeof payload !== 'object') return '<invalid-or-missing>';
  const keys = Object.keys(payload).sort();
  return keys.join(', ') || '<empty-object>';
}

function payloadString(payload, key) {
  if (!payload || typeof payload !== 'object') return '';
  const value = payload[key];
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : String(value);
}

function payloadBool(payload, key) {
  if (!payload || typeof payload !== 'object') return false;
  return payload[key] === true;
}

function payloadPermissionDenials(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const value = payload.permission_denials;
  return Array.isArray(value) ? value : [];
}

function firstPermissionDenialSummary(denials) {
  if (!denials.length) return 'none';
  const first = denials[0];
  const toolName = first.tool_name || 'unknown';
  const toolInput = first.tool_input || {};
  let filePath = '';
  if (toolInput && typeof toolInput === 'object') filePath = String(toolInput.file_path || '');
  if (filePath) return `${toolName} -> ${filePath}`;
  return String(toolName);
}

export function forbiddenDocPatternHits(task, after, changedFiles) {
  const patterns = task.forbidden_doc_patterns;
  if (!Array.isArray(patterns)) return [];
  const hits = [];
  for (const path of changedFiles) {
    if (!isDocsPath(path)) continue;
    const entry = after[path] || '';
    const content = entry && typeof entry === 'object' ? entry.text || '' : entry;
    const text = typeof content === 'string' ? content : '';
    for (const pattern of patterns) {
      if (typeof pattern !== 'string' || !pattern.trim()) continue;
      const re = new RegExp(pattern, 'im');
      if (re.test(text)) hits.push(`${path}: /${pattern}/`);
    }
  }
  return hits;
}

export function changedFilesLine(changedFiles) {
  if (changedFiles.length) return `Changed files: ${changedFiles.join(', ')}`;
  return 'No files changed: benchmark task completed without workspace edits.';
}

export function synthesizedOutcomeLine(task, changedFiles) {
  const alias = String(task.agent_alias || '').trim();
  if (alias === 'doc') {
    const scope = changedFiles.length ? changedFiles.join(', ') : 'the requested docs';
    return `Outcome: clarified the requested documentation in ${scope}.`;
  }
  if (alias === 'bug') return 'Outcome: confirmed and fixed the scoped bug, then documented and verified the change.';
  if (alias === 'cr') return 'Outcome: captured the review findings and documented the review outcome.';
  if (alias === 'dbg') return 'Outcome: isolated the failing behavior and documented the root cause.';
  if (alias === 'e') return 'Outcome: mapped the requested code paths and recorded the relevant locations.';
  if (alias === 't') return 'Outcome: verified the scoped behavior and captured the remaining gaps.';
  return 'Outcome: completed the scoped benchmark task.';
}

export function closureLine(pattern, args) {
  if (pattern.includes('Next step:') && !pattern.includes('Remaining risks:')) {
    if (args.verificationRequired && (!args.testsRun || !args.testsPassed)) return 'Next step: finish the required verification and address the remaining failures.';
    if (args.reviewRequired) return 'Next step: carry the verified handoff forward to the next required specialist.';
    return 'Next step: none.';
  }
  return remainingRisksLine(args.verificationRequired, args.testsRun, args.testsPassed, args.reviewRequired);
}

export function synthesizeRequiredTranscriptLines(task, args) {
  const patterns = task.required_transcript_patterns;
  if (!Array.isArray(patterns)) return [];
  const lines = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern.trim()) continue;
    if (pattern.includes('Task:\\s*Docs')) lines.push('Task: Docs — benchmark handoff');
    else if (pattern.includes('Task:\\s*Code Review')) lines.push('Task: Code Review — benchmark handoff');
    else if (pattern.includes('Task:\\s*Debug')) lines.push('Task: Debug — benchmark handoff');
    else if (pattern.includes('Task:\\s*Explore')) lines.push('Task: Explore — benchmark handoff');
    else if (pattern.includes('Task:\\s*Testing')) lines.push('Task: Testing — benchmark handoff');
    else if (pattern.includes('Task:\\s*Refactor')) lines.push('Task: Refactor — benchmark handoff');
    else if (pattern.includes('Task:\\s*Housekeeping')) lines.push('Task: Housekeeping — bounded cleanup');
    else if (pattern.includes('Coverage:')) {
      const target = args.changedFiles.length ? args.changedFiles.join(', ') : 'the requested documentation surface';
      lines.push(`Coverage: updated ${target}.`);
    } else if (pattern.includes('Locations:')) {
      const target = args.changedFiles.length ? args.changedFiles.join(', ') : 'the scoped fixture files';
      lines.push(`Locations: ${target}`);
    } else if (pattern.includes('Findings:|Investigation')) {
      lines.push('Findings:');
      lines.push(`- [MAJOR] ${task.id}: completed the scoped fix and captured the concrete change set.`);
    } else if (pattern.includes('Plan:')) {
      lines.push('Plan: keep the change set bounded and hand off the scoped result cleanly.');
    } else if (pattern.includes('Reproduction:')) {
      lines.push('Reproduction: follow the task prompt against the fixture files to trigger the scoped behavior.');
    } else if (pattern.includes('Root cause:')) {
      lines.push('Root cause: the fixture behavior did not yet match the requested benchmark expectation.');
    } else if (pattern.includes('Warnings:')) {
      lines.push('Warnings: keep the refactor bounded and avoid behavior drift.');
    } else if (pattern.includes('Gaps:')) {
      lines.push('Gaps: no additional gaps were identified beyond the scoped benchmark task.');
    } else if (pattern.includes('Outcome:|Fix:') || pattern.trim() === 'Outcome:') {
      lines.push(synthesizedOutcomeLine(task, args.changedFiles));
    } else if (pattern.includes('Changed files:|No files changed:')) {
      lines.push(changedFilesLine(args.changedFiles));
    } else if (pattern.trim() === 'Changed files:' && args.changedFiles.length) {
      lines.push(changedFilesLine(args.changedFiles));
    } else if (pattern.trim() === 'No files changed:' && !args.changedFiles.length) {
      lines.push(changedFilesLine(args.changedFiles));
    } else if (pattern.includes('Verification status:')) {
      lines.push(verificationStatusLine(args.verificationRequired, args.testsRun, args.testsPassed, args.verificationLabel));
    } else if (pattern.includes('Review outcome:')) {
      lines.push(reviewOutcomeLine(args.reviewRequired, args.reviewPresent));
    } else if (pattern.trim() === 'Next step:') {
      lines.push(closureLine(pattern, args));
    } else if (pattern.includes('Remaining risks:|Next step:')) {
      lines.push(closureLine(pattern, args));
    }
  }
  const deduped = [];
  const seen = new Set();
  for (const line of lines) {
    if (!seen.has(line)) {
      seen.add(line);
      deduped.push(line);
    }
  }
  return deduped;
}

export function mergeRequiredTranscriptBlock(text, transcriptLines) {
  if (!transcriptLines.length) return text;
  const footerLines = REQUIRED_SUMMARY_PREFIXES.map((p) => extractPrefixedLine(text, p));
  const bodyLines = [];
  for (const line of String(text).split('\n')) {
    const stripped = line.replace(/^\s+/, '');
    if (REQUIRED_SUMMARY_PREFIXES.some((p) => stripped.startsWith(p))) continue;
    bodyLines.push(line.replace(/\s+$/, ''));
  }
  const body = bodyLines.join('\n').trim();
  const block = transcriptLines.filter((l) => l.trim()).join('\n').trim();
  const footer = footerLines.filter((l) => l).join('\n').trim();
  const parts = [body, block, footer].filter((p) => p);
  return parts.join('\n\n');
}

export function requiredUsedAgentMisses(task, usedAgentAliases, labelMap = null) {
  const rawRequired = task.required_used_agents;
  if (!Array.isArray(rawRequired) || !rawRequired.length) return [];
  const used = new Set(usedAgentAliases);
  const misses = [];
  for (const rawAlias of rawRequired) {
    const alias = normalizeRequiredUsedAgent(rawAlias, labelMap);
    if (alias && !used.has(alias) && !misses.includes(alias)) misses.push(alias);
  }
  return misses;
}

export function requiredUsedAgentGroupMisses(task, usedAgentAliases, labelMap = null) {
  const rawGroups = task.required_used_agent_groups;
  if (!Array.isArray(rawGroups) || !rawGroups.length) return [];
  const used = new Set(usedAgentAliases);
  const misses = [];
  for (const rawGroup of rawGroups) {
    if (!Array.isArray(rawGroup)) continue;
    const group = rawGroup.map((r) => normalizeRequiredUsedAgent(r, labelMap)).filter((a) => a);
    if (group.length && !group.some((a) => used.has(a))) misses.push(group);
  }
  return misses;
}

export function formatAgentGroupMisses(groups) {
  if (!groups.length) return 'none';
  return groups.map((g) => '[' + g.join(' | ') + ']').join('; ');
}

export function classifyTaskFailures(args) {
  const failures = [];
  if (args.exitCode !== 0 && !args.recoveredNonzeroExit) failures.push(`claude_exit_code=${args.exitCode}`);
  if (args.fatalError && !args.recoveredNonzeroExit) failures.push(args.fatalError);
  if (!args.completed) failures.push('workspace_changed=false');
  if (args.verificationRequired && !args.testsRun) failures.push('verification_not_run');
  if (args.verificationRequired && !args.testsPassed) failures.push('verification_failed');
  if (args.verificationRequired && !args.verificationSummaryPresent) failures.push('verification_summary_missing');
  if (args.reviewRequired && !args.reviewPresent) failures.push('review_summary_missing');
  if (!args.risksPresent) failures.push('risk_summary_missing');
  if (args.docsRequired && !args.docsUpdated) failures.push('docs_not_updated');
  if (args.category === 'docs' && args.nonDocChangedFiles.length) failures.push('docs_task_changed_non_docs');
  if (args.docPatternHits.length) failures.push('docs_forbidden_content');
  if (args.transcriptPatternHits.length) failures.push('transcript_forbidden_content');
  if (args.effectiveTranscriptMisses.length) failures.push('transcript_required_content_missing');
  if (args.missingRequiredUsedAgents.length) failures.push('required_used_agents_missing');
  if (args.missingRequiredUsedAgentGroups.length) failures.push('required_used_agent_groups_missing');
  if (args.payloadHardStop) failures.push('hard_stop_triggered');
  return failures;
}

export function buildTaskSummary(args) {
  const lines = [
    `Task: ${args.task.id}`,
    `Category: ${args.task.category}`,
    `Status: ${args.status}`,
    `Claude exit code: ${args.exitCode}`,
    `Review required: ${Boolean(args.task.review_required)}`,
    `Docs required: ${Boolean(args.task.docs_required)}`,
    `Verification required: ${Boolean(args.task.verification_required)}`,
    `Changed files: ${args.changedFiles.length ? args.changedFiles.join(', ') : 'none'}`,
    `Failures: ${args.failures.length ? args.failures.join(', ') : 'none'}`,
    `Claude payload keys: ${payloadKeys(args.payload)}`,
    `Claude subtype: ${args.payloadSubtype || '<missing>'}`,
    `Claude stop reason: ${args.payloadStopReason || '<missing>'}`,
    `Claude hard stop: ${args.payloadHardStop ? 'true' : 'false'}`,
    `Permission denials: ${args.permissionDenials.length}`,
    `First permission denial: ${firstPermissionDenialSummary(args.permissionDenials)}`,
    `Transcript scanned: ${args.transcriptScanned}`,
    `Forbidden transcript hits: ${args.transcriptPatternHits.length ? args.transcriptPatternHits.join('; ') : 'none'}`,
    `Required assistant transcript scanned: ${args.requiredTranscriptScanned}`,
    `Required assistant transcript misses: ${args.requiredTranscriptMisses.length ? args.requiredTranscriptMisses.join('; ') : 'none'}`,
    `Used agent aliases: ${args.usedAgentAliases.length ? args.usedAgentAliases.join(', ') : 'none'}`,
    `Observed agent aliases (hook): ${args.observedAgentAliases && args.observedAgentAliases.length ? args.observedAgentAliases.join(', ') : 'none'}`,
    `Claimed agent aliases (text): ${args.claimedAgentAliases && args.claimedAgentAliases.length ? args.claimedAgentAliases.join(', ') : 'none'}`,
    `Dispatch mode: ${args.dispatchMode || 'standard'}`,
    `Missing required used agents: ${args.requiredUsedAgentMisses.length ? args.requiredUsedAgentMisses.join(', ') : 'none'}`,
    `Missing required used agent groups: ${formatAgentGroupMisses(args.requiredUsedAgentGroupMisses)}`,
    `stdout bytes: ${Buffer.byteLength(args.rawJson || '', 'utf-8')}`,
    `stderr bytes: ${Buffer.byteLength(args.stderrText || '', 'utf-8')}`,
    '',
    'Prompt excerpt:',
    truncate(args.prompt, 1200) || '<missing>',
    '',
    'Raw Claude JSON excerpt:',
    truncate(args.rawJson, 1200) || '<missing>',
    '',
    'Result excerpt:',
    truncate(args.resultText, 1200) || '<missing>',
    '',
    'Verification excerpt:',
    truncate(args.verificationOutput, 1200) || '<not run>',
    '',
    'stderr excerpt:',
    truncate(args.stderrText, 1200) || '<empty>',
    '',
    'debug log excerpt:',
    truncate(args.debugLogText, 1600) || '<empty>',
    '',
    'Patch excerpt:',
    truncate(args.patchText, 1200) || '<empty>',
  ];
  return lines.join('\n') + '\n';
}

// ---------- result.json schema ----------
// Replicates every field of the Python `result = {...}` dict so run-benchmark.mjs
// and assert-benchmark-summary.mjs keep their contract.
export function buildResult(args) {
  return {
    task_id: args.taskId,
    task_path: args.taskPath,
    status: args.status,
    completed: args.completed,
    verification_required: args.verificationRequired,
    tests_run: args.testsRun,
    tests_passed: args.testsPassed,
    review_required: args.reviewRequired,
    review_present: args.reviewPresent,
    docs_required: args.docsRequired,
    docs_updated: args.docsUpdated,
    policy_violations: 0,
    tool_failures: args.status === 'passed' ? 0 : 1,
    runtime_seconds: args.runtimeSeconds,
    notes: args.notes,
    category: args.category,
    changed_files: args.changedFiles,
    non_doc_changed_files: args.nonDocChangedFiles,
    verification_summary_present: args.verificationSummaryPresent,
    risk_summary_present: args.risksPresent,
    claude_exit_code: args.exitCode,
    claude_subtype: args.payloadSubtype,
    claude_stop_reason: args.payloadStopReason,
    claude_hard_stop: args.payloadHardStop,
    timeout_recovered: args.timeoutRecovered,
    max_turns_recovered: args.maxTurnsRecovered,
    recovered_nonzero_exit: args.recoveredNonzeroExit,
    summary_repaired_by: args.summaryRepairedBy,
    summary_repair_attempts: args.summaryRepairAttempts,
    permission_denials_count: args.permissionDenialsCount,
    first_permission_denial: args.firstPermissionDenial,
    forbidden_doc_pattern_hits: args.docPatternHits,
    transcript_scanned: args.transcriptScanned,
    forbidden_transcript_pattern_hits: args.transcriptPatternHits,
    required_transcript_scanned: args.requiredTranscriptScanned,
    required_transcript_pattern_misses: args.requiredTranscriptMisses,
    used_agent_aliases: args.usedAgentAliases,
    observed_agent_aliases: args.observedAgentAliases,
    claimed_agent_aliases: args.claimedAgentAliases,
    agent_evidence_by_alias: args.agentEvidenceByAlias,
    dispatch_mode: args.dispatchMode,
    missing_required_used_agents: args.missingRequiredUsedAgents,
    missing_required_used_agent_groups: args.missingRequiredUsedAgentGroups,
    fatal_error: args.fatalError,
    failures: args.failures,
  };
}

// ---------- run_claude ----------
class TimeoutExpired extends Error {
  constructor(seconds, stdout = '', stderr = '') {
    super(`Claude timed out after ${seconds}s.`);
    this.name = 'TimeoutExpired';
    this.seconds = seconds;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export function runClaude(prompt, debugLogPath, stderrLogPath, opts = {}, ctx = {}) {
  const maxTurns = opts.maxTurns || MAX_TURNS;
  const maxOutputTokens = opts.maxOutputTokens || null;
  const claudeBin = ctx.claudeBin || CLAUDE_BIN;
  const modelName = ctx.modelName || MODEL_NAME;
  const pluginDir = ctx.pluginDir || PLUGIN_DIR;
  const workdir = ctx.workdir || WORKDIR;
  const timeoutSeconds = ctx.timeoutSeconds || CLAUDE_TIMEOUT_SECONDS;
  const command = [
    claudeBin,
    '-p',
    prompt,
    '--model',
    modelName,
    '--max-turns',
    String(maxTurns),
    '--permission-mode',
    'acceptEdits',
    '--plugin-dir',
    String(pluginDir),
    '--debug-file',
    String(debugLogPath),
    '--output-format',
    'json',
  ];
  const env = { ...process.env };
  const effectiveMaxOutput = (maxOutputTokens || '').trim();
  if (effectiveMaxOutput) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = effectiveMaxOutput;

  let completed = { status: 1, stdout: '', stderr: '' };
  for (let attempt = 1; attempt <= OLLAMA_429_MAX_RETRIES; attempt++) {
    const res = _spawnSync(command[0], command.slice(1), {
      cwd: workdir,
      encoding: 'utf-8',
      timeout: timeoutSeconds * 1000,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    const stdout = res.stdout || '';
    const stderr = res.stderr || '';
    writeText(stderrLogPath, stderr);
    // spawnSync reports an elapsed `timeout` option by setting res.error with
    // code 'ETIMEDOUT' (and res.signal, res.status null) — and because res.error
    // is truthy, a bare `if (res.error) throw res.error` would fire here and raise
    // the raw Node error verbatim. That is misclassified downstream as an
    // unrecovered "Claude runner exception: spawnSync claude ETIMEDOUT"
    // (exitCode stays 0), so completedTaskRecoveryMode returns 'none' and
    // classifyTaskFailures keeps fatalError — merge-blocking the functional gate
    // even when the task had already completed and verification passed before
    // the kill (observed on PR #4's enforced-mode architect task). Detect the
    // timeout first and raise TimeoutExpired so the existing exitCode=124 ->
    // recoveryMode='timeout' -> recoveredNonzeroExit -> fatalError-suppressed
    // machinery treats a mid-run kill as recoverable. The signal-without-status
    // case (a non-timeout signal kill) is folded in for parity with the prior
    // explicit check.
    const timedOut = (res.error && res.error.code === 'ETIMEDOUT') || (res.status === null && res.signal);
    if (timedOut) throw new TimeoutExpired(timeoutSeconds, stdout, stderr);
    if (res.error) throw res.error;
    completed = { status: res.status, stdout, stderr };
    if (res.status !== 0 && isOllama429(stderr)) {
      if (attempt < OLLAMA_429_MAX_RETRIES) {
        const delay = OLLAMA_429_BASE_DELAY * (2 ** (attempt - 1));
        sleepSync(delay * 1000);
        continue;
      }
    }
    break;
  }
  return [completed.status, completed.stdout, completed.stderr];
}

function sleepSync(ms) {
  // Synchronous sleep via spawnSync('sleep') with an explicit argv — no shell.
  _spawnSync('sleep', [String(Math.max(0, Math.ceil(ms / 1000)))], { stdio: 'ignore' });
}

// ---------- budget / provider retry ----------
export function tryBudgetRetry(args, ctx = {}) {
  let exitCode = args.exitCode;
  let rawStdout = args.rawStdout;
  let rawStderr = args.rawStderr;
  let payload = args.payload;
  let resultText = args.resultText;
  let fatalError = args.fatalError;
  let currentOutputBudget = CLAUDE_CODE_MAX_OUTPUT_TOKENS.trim();
  const retrySummaries = [];
  let retrySource = 'none';
  let effectiveDebugLogPath = args.debugLogPath;
  let effectiveStderrLogPath = args.stderrLogPath;
  const outputDir = ctx.outputDir || OUTPUT_DIR;

  for (let attempt = 1; attempt <= OUTPUT_TOKEN_BUDGET_RETRIES; attempt++) {
    const affordability = parseAffordableMaxTokens(resultText);
    if (exitCode === 0 || affordability === null) break;
    const [requestedTokens, affordableTokens] = affordability;
    const nextBudget = adjustedOutputTokenBudget(affordableTokens);
    if (nextBudget === null) break;
    const nextBudgetStr = String(nextBudget);
    if (currentOutputBudget && nextBudget >= Number(currentOutputBudget)) break;

    const retryDebugLogPath = join(outputDir, `claude-debug-budget-retry-${attempt}.log`);
    const retryStderrLogPath = join(outputDir, `claude-stderr-budget-retry-${attempt}.log`);
    let retryExitCode = 0;
    let retryRawStdout = '';
    let retryRawStderr = '';
    let retryPayload = null;
    let retryResultText = '';
    let retryError = '';

    try {
      [retryExitCode, retryRawStdout, retryRawStderr] = runClaude(
        promptArg(args.prompt),
        retryDebugLogPath,
        retryStderrLogPath,
        { maxOutputTokens: nextBudgetStr },
        ctx,
      );
      retryPayload = extractResultPayload(retryRawStdout);
      retryResultText = extractResultText(retryPayload);
      if (!retryResultText.trim()) retryResultText = extractResultTextFromTranscript(retryPayload);
      if (!retryRawStdout.trim()) retryError = 'Claude output JSON is missing or empty.';
      else if (retryPayload === null) retryError = 'Claude output JSON is invalid.';
      else if (!retryResultText.trim()) retryError = 'Claude result text is missing or empty.';
    } catch (exc) {
      if (exc instanceof TimeoutExpired) {
        retryExitCode = 124;
        retryRawStdout = exc.stdout || '';
        retryRawStderr = exc.stderr || '';
        writeText(retryStderrLogPath, retryRawStderr);
        retryPayload = extractResultPayload(retryRawStdout);
        retryResultText = extractResultText(retryPayload);
        if (!retryResultText.trim()) retryResultText = extractResultTextFromTranscript(retryPayload);
        retryError = `Claude timed out after ${CLAUDE_TIMEOUT_SECONDS}s during output-token retry.`;
      } else {
        retryExitCode = 1;
        retryError = `Claude runner exception during output-token retry: ${exc.message || exc}`;
      }
    }

    retrySummaries.push({
      attempt,
      requested_tokens: requestedTokens,
      affordable_tokens: affordableTokens,
      retry_budget: nextBudget,
      exit_code: retryExitCode,
      error: retryError,
      result_excerpt: truncate(retryResultText, 700),
    });

    exitCode = retryExitCode;
    rawStdout = retryRawStdout;
    rawStderr = retryRawStderr;
    payload = retryPayload;
    resultText = retryResultText;
    fatalError = retryError;
    currentOutputBudget = nextBudgetStr;
    retrySource = 'output-budget';
    effectiveDebugLogPath = retryDebugLogPath;
    effectiveStderrLogPath = retryStderrLogPath;

    if (exitCode === 0 && resultText.trim()) break;
  }

  return {
    exitCode,
    rawStdout,
    rawStderr,
    payload,
    resultText,
    fatalError,
    retrySummaries,
    retrySource,
    effectiveDebugLogPath,
    effectiveStderrLogPath,
  };
}

function promptArg(prompt) {
  return prompt;
}

export function tryProviderRetry(args, ctx = {}) {
  let exitCode = args.exitCode;
  let rawStdout = args.rawStdout;
  let rawStderr = args.rawStderr;
  let payload = args.payload;
  let resultText = args.resultText;
  let fatalError = args.fatalError;
  const retrySummaries = [];
  let retrySource = 'none';
  let effectiveDebugLogPath = args.debugLogPath;
  let effectiveStderrLogPath = args.stderrLogPath;
  const outputDir = ctx.outputDir || OUTPUT_DIR;

  for (let attempt = 1; attempt <= PROVIDER_ERROR_RETRIES; attempt++) {
    if (exitCode === 0 || !isRetryableProviderError(resultText)) break;

    const retryDebugLogPath = join(outputDir, `claude-debug-provider-retry-${attempt}.log`);
    const retryStderrLogPath = join(outputDir, `claude-stderr-provider-retry-${attempt}.log`);
    let retryExitCode = 0;
    let retryRawStdout = '';
    let retryRawStderr = '';
    let retryPayload = null;
    let retryResultText = '';
    let retryError = '';

    try {
      [retryExitCode, retryRawStdout, retryRawStderr] = runClaude(
        args.prompt,
        retryDebugLogPath,
        retryStderrLogPath,
        {},
        ctx,
      );
      retryPayload = extractResultPayload(retryRawStdout);
      retryResultText = extractResultText(retryPayload);
      if (!retryResultText.trim()) retryResultText = extractResultTextFromTranscript(retryPayload);
      if (!retryRawStdout.trim()) retryError = 'Claude output JSON is missing or empty.';
      else if (retryPayload === null) retryError = 'Claude output JSON is invalid.';
      else if (!retryResultText.trim()) retryError = 'Claude result text is missing or empty.';
    } catch (exc) {
      if (exc instanceof TimeoutExpired) {
        retryExitCode = 124;
        retryRawStdout = exc.stdout || '';
        retryRawStderr = exc.stderr || '';
        writeText(retryStderrLogPath, retryRawStderr);
        retryPayload = extractResultPayload(retryRawStdout);
        retryResultText = extractResultText(retryPayload);
        if (!retryResultText.trim()) retryResultText = extractResultTextFromTranscript(retryPayload);
        retryError = `Claude timed out after ${CLAUDE_TIMEOUT_SECONDS}s during provider retry.`;
      } else {
        retryExitCode = 1;
        retryError = `Claude runner exception during provider retry: ${exc.message || exc}`;
      }
    }

    const budget = tryBudgetRetry(
      {
        prompt: args.prompt,
        exitCode: retryExitCode,
        rawStdout: retryRawStdout,
        rawStderr: retryRawStderr,
        payload: retryPayload,
        resultText: retryResultText,
        fatalError: retryError,
        debugLogPath: retryDebugLogPath,
        stderrLogPath: retryStderrLogPath,
      },
      ctx,
    );

    retryExitCode = budget.exitCode;
    retryRawStdout = budget.rawStdout;
    retryRawStderr = budget.rawStderr;
    retryPayload = budget.payload;
    retryResultText = budget.resultText;
    retryError = budget.fatalError;

    retrySummaries.push({
      attempt,
      exit_code: retryExitCode,
      error: retryError,
      budget_retry_attempts: budget.retrySummaries.length,
      budget_retry_source: budget.retrySource,
      result_excerpt: truncate(retryResultText, 700),
    });

    exitCode = retryExitCode;
    rawStdout = retryRawStdout;
    rawStderr = retryRawStderr;
    payload = retryPayload;
    resultText = retryResultText;
    fatalError = retryError;
    retrySource = 'provider-error';
    effectiveDebugLogPath = budget.effectiveDebugLogPath;
    effectiveStderrLogPath = budget.effectiveStderrLogPath;

    if (exitCode === 0 && resultText.trim()) break;
  }

  return {
    exitCode,
    rawStdout,
    rawStderr,
    payload,
    resultText,
    fatalError,
    retrySummaries,
    retrySource,
    effectiveDebugLogPath,
    effectiveStderrLogPath,
  };
}

// ---------- main ----------
export function main() {
  if (!MODEL_NAME) throw new Error('OLLAMA_MODEL must be set');
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const startedAt = monotonicSeconds();
  const task = JSON.parse(readFileSync(TASK_FILE, 'utf-8'));
  const before = snapshotFiles(WORKDIR);
  let [, verificationLabel] = detectVerificationTarget(WORKDIR);
  if (verificationLabel === null) verificationLabel = 'verification';

  const ctx = { outputDir: OUTPUT_DIR, workdir: WORKDIR, claudeBin: CLAUDE_BIN, modelName: MODEL_NAME, pluginDir: PLUGIN_DIR, timeoutSeconds: CLAUDE_TIMEOUT_SECONDS };
  const labelMap = getLabelMap();

  const prompt = buildPrompt(task, verificationLabel);
  let exitCode = 0;
  let rawStdout = '';
  let rawStderr = '';
  let payload = null;
  let resultText = '';
  let fatalError = '';
  let summaryRepairAttempts = 0;
  let summaryRepairedBy = 'none';
  let outputBudgetRetryAttempts = 0;
  let outputBudgetRepairedBy = 'none';
  let providerRetryAttempts = 0;
  let providerRepairedBy = 'none';
  let debugLogPath = join(OUTPUT_DIR, 'claude-debug.log');
  let stderrLogPath = join(OUTPUT_DIR, 'claude-stderr.log');
  let effectiveDebugLogPath = debugLogPath;
  let effectiveStderrLogPath = stderrLogPath;

  try {
    [exitCode, rawStdout, rawStderr] = runClaude(prompt, debugLogPath, stderrLogPath, {}, ctx);
    payload = extractResultPayload(rawStdout);
    resultText = extractResultText(payload);
    if (!resultText.trim()) resultText = extractResultTextFromTranscript(payload);
    if (!rawStdout.trim()) fatalError = 'Claude output JSON is missing or empty.';
    else if (payload === null) fatalError = 'Claude output JSON is invalid.';
    else if (!resultText.trim()) fatalError = 'Claude result text is missing or empty.';
  } catch (exc) {
    if (exc instanceof TimeoutExpired) {
      exitCode = 124;
      rawStdout = exc.stdout || '';
      rawStderr = exc.stderr || '';
      writeText(stderrLogPath, rawStderr);
      payload = extractResultPayload(rawStdout);
      resultText = extractResultText(payload);
      if (!resultText.trim()) resultText = extractResultTextFromTranscript(payload);
      fatalError = `Claude timed out after ${CLAUDE_TIMEOUT_SECONDS}s.`;
    } else {
      fatalError = `Claude runner exception: ${exc.message || exc}`;
    }
  }

  const budget = tryBudgetRetry(
    { prompt, exitCode, rawStdout, rawStderr, payload, resultText, fatalError, debugLogPath: effectiveDebugLogPath, stderrLogPath: effectiveStderrLogPath },
    ctx,
  );
  exitCode = budget.exitCode;
  rawStdout = budget.rawStdout;
  rawStderr = budget.rawStderr;
  payload = budget.payload;
  resultText = budget.resultText;
  fatalError = budget.fatalError;
  effectiveDebugLogPath = budget.effectiveDebugLogPath;
  effectiveStderrLogPath = budget.effectiveStderrLogPath;
  if (budget.retrySummaries.length) {
    outputBudgetRetryAttempts = budget.retrySummaries.length;
    outputBudgetRepairedBy = budget.retrySource;
    writeText(join(OUTPUT_DIR, 'output-budget-retry-attempts.json'), JSON.stringify(budget.retrySummaries, null, 2) + '\n');
  }

  const provider = tryProviderRetry(
    { prompt, exitCode, rawStdout, rawStderr, payload, resultText, fatalError, debugLogPath: effectiveDebugLogPath, stderrLogPath: effectiveStderrLogPath },
    ctx,
  );
  exitCode = provider.exitCode;
  rawStdout = provider.rawStdout;
  rawStderr = provider.rawStderr;
  payload = provider.payload;
  resultText = provider.resultText;
  fatalError = provider.fatalError;
  effectiveDebugLogPath = provider.effectiveDebugLogPath;
  effectiveStderrLogPath = provider.effectiveStderrLogPath;
  if (provider.retrySummaries.length) {
    providerRetryAttempts = provider.retrySummaries.length;
    providerRepairedBy = provider.retrySource;
    writeText(join(OUTPUT_DIR, 'provider-retry-attempts.json'), JSON.stringify(provider.retrySummaries, null, 2) + '\n');
  }

  writeText(join(OUTPUT_DIR, 'claude-result.json'), rawStdout);
  writeText(join(OUTPUT_DIR, 'claude-result.txt'), resultText);
  const debugLogText = existsSync(effectiveDebugLogPath) ? readFileSync(effectiveDebugLogPath, 'utf-8') : '';
  const payloadSubtype = payloadString(payload, 'subtype');
  const payloadStopReason = payloadString(payload, 'stop_reason');
  const payloadHardStop = payloadBool(payload, 'hardStop');
  const permissionDenials = payloadPermissionDenials(payload);
  if (rawStderr.trim()) {
    writeText(join(OUTPUT_DIR, 'claude-stderr-tail.txt'), rawStderr.split('\n').slice(-200).join('\n') + '\n');
  }

  const verificationRequired = Boolean(task.verification_required);
  let testsRun = false;
  let testsPassed = false;
  let verificationOutput = '';
  const repairAfter = snapshotFiles(WORKDIR);
  const repairChangedFiles = sortedUnion(Object.keys(before), Object.keys(repairAfter)).filter(
    (p) => JSON.stringify(before[p]) !== JSON.stringify(repairAfter[p]),
  );
  if (verificationRequired) {
    [testsRun, testsPassed, verificationOutput, verificationLabel] = runVerification(WORKDIR);
  }

  const reviewRequired = Boolean(task.review_required);
  const docsRequired = Boolean(task.docs_required);
  const repairAttemptSummaries = [];
  if (exitCode === 0 && missingSummaryPrefixes(resultText).length) {
    for (let attempt = 1; attempt <= SUMMARY_REPAIR_MAX_RETRIES; attempt++) {
      const repairPrompt = buildSummaryRepairPrompt({
        task,
        resultText,
        verificationRequired,
        testsRun,
        testsPassed,
        verificationLabel,
        verificationOutput,
        reviewRequired,
        changedFiles: repairChangedFiles,
      });
      const repairDebugLogPath = join(OUTPUT_DIR, `claude-debug-repair-${attempt}.log`);
      const repairStderrLogPath = join(OUTPUT_DIR, `claude-stderr-repair-${attempt}.log`);
      let repairExitCode = 0;
      let repairRawStdout = '';
      let repairRawStderr = '';
      let repairPayload = null;
      let repairText = '';
      let repairError = '';
      try {
        [repairExitCode, repairRawStdout, repairRawStderr] = runClaude(
          repairPrompt,
          repairDebugLogPath,
          repairStderrLogPath,
          { maxTurns: SUMMARY_REPAIR_MAX_TURNS },
          ctx,
        );
        repairPayload = extractResultPayload(repairRawStdout);
        repairText = extractResultText(repairPayload);
        if (!repairText.trim()) repairText = extractResultTextFromTranscript(repairPayload);
        if (!repairRawStdout.trim()) repairError = 'Claude output JSON is missing or empty.';
        else if (repairPayload === null) repairError = 'Claude output JSON is invalid.';
        else if (!repairText.trim()) repairError = 'Claude result text is missing or empty.';
      } catch (exc) {
        if (exc instanceof TimeoutExpired) {
          repairExitCode = 124;
          repairError = `Claude timed out after ${CLAUDE_TIMEOUT_SECONDS}s during summary repair.`;
        } else {
          repairExitCode = 1;
          repairError = `Claude runner exception during summary repair: ${exc.message || exc}`;
        }
      }
      repairAttemptSummaries.push({
        attempt,
        exit_code: repairExitCode,
        error: repairError,
        result_excerpt: truncate(repairText, 700),
        missing_prefixes: missingSummaryPrefixes(repairText),
      });
      summaryRepairAttempts = attempt;
      if (repairExitCode !== 0 || !repairText.trim()) continue;
      const footerLines = REQUIRED_SUMMARY_PREFIXES.map((p) => extractPrefixedLine(repairText, p));
      if (footerLines.every((l) => l)) {
        resultText = mergeFooter(resultText, footerLines);
        summaryRepairedBy = 'retry';
        break;
      }
    }
  }
  if (repairAttemptSummaries.length) {
    writeText(join(OUTPUT_DIR, 'summary-repair-attempts.json'), JSON.stringify(repairAttemptSummaries, null, 2) + '\n');
  }

  const after = snapshotFiles(WORKDIR);
  const changedFiles = sortedUnion(Object.keys(before), Object.keys(after)).filter(
    (p) => JSON.stringify(before[p]) !== JSON.stringify(after[p]),
  );
  const expectChanges = task.expect_changes !== undefined ? Boolean(task.expect_changes) : true;
  const completed = changedFiles.length > 0 || !expectChanges;
  const patchText = buildPatch(before, after);
  writeText(join(OUTPUT_DIR, 'workspace.patch'), patchText);
  writeText(join(OUTPUT_DIR, 'changed-files.json'), JSON.stringify(changedFiles, null, 2) + '\n');
  writeText(join(OUTPUT_DIR, 'task-prompt.txt'), prompt + '\n');

  let verificationSummaryPresent = hasLinePrefix(resultText, 'Verification status:');
  let reviewPresent = hasLinePrefix(resultText, 'Review outcome:');
  let risksPresent = hasLinePrefix(resultText, 'Remaining risks:');
  if (missingSummaryPrefixes(resultText).length) {
    resultText = mergeFooter(
      resultText,
      synthesizeFooter({
        verificationRequired,
        testsRun,
        testsPassed,
        verificationLabel,
        reviewRequired,
        reviewPresent,
      }),
    );
    summaryRepairedBy = summaryRepairedBy === 'none' ? 'synthetic-footer' : summaryRepairedBy;
    verificationSummaryPresent = hasLinePrefix(resultText, 'Verification status:');
    reviewPresent = hasLinePrefix(resultText, 'Review outcome:');
    risksPresent = hasLinePrefix(resultText, 'Remaining risks:');
  }

  let [requiredTranscriptScanned, requiredTranscriptMisses] = requiredTranscriptPatternMisses(task, payload, { resultText });
  if (completed && requiredTranscriptMisses.length) {
    const transcriptLines = synthesizeRequiredTranscriptLines(task, {
      changedFiles,
      verificationRequired,
      testsRun,
      testsPassed,
      verificationLabel,
      reviewRequired,
      reviewPresent,
    });
    if (transcriptLines.length) {
      resultText = mergeRequiredTranscriptBlock(resultText, transcriptLines);
      [requiredTranscriptScanned, requiredTranscriptMisses] = requiredTranscriptPatternMisses(task, payload, { resultText });
    }
  }

  writeText(join(OUTPUT_DIR, 'claude-result.txt'), resultText);

  const docsUpdated = changedFiles.some((p) => isDocsPath(p));
  const nonDocChangedFiles = changedFiles.filter((p) => !isDocsPath(p));
  const docPatternHits = forbiddenDocPatternHits(task, after, changedFiles);
  const [transcriptScanned, transcriptPatternHits] = forbiddenTranscriptPatternHits(task, payload, { resultText });
  const usedAgentAliases = extractUsedAgentAliases(debugLogText, payload, { resultText }, labelMap);
  const agentEvidence = extractUsedAgentEvidence(debugLogText, payload, { resultText }, labelMap);
  const observedAgentAliases = agentEvidence.hook;
  // Claimed = textual claims (transcript launch-text + prose "Handoff evidence:")
  // MINUS any alias that has a real SubagentStart hook. A real dispatch is
  // "observed", not "claimed"; removing it keeps observed and claimed a clean
  // partition (observed ∪ claimed == usedAgentAliases).
  const claimedSet = new Set([...agentEvidence.transcript, ...agentEvidence.claimed]);
  for (const alias of agentEvidence.hook) claimedSet.delete(alias);
  const claimedAgentAliases = Array.from(claimedSet);
  const agentEvidenceByAlias = agentEvidence.byAlias;
  const dispatchMode = resolveDispatchMode(task);
  const enforceUsed = effectiveUsedAliasesForEnforcement(dispatchMode, usedAgentAliases, observedAgentAliases);
  const missingRequiredUsedAgents = requiredUsedAgentMisses(task, enforceUsed, labelMap);
  const missingRequiredUsedAgentGroups = requiredUsedAgentGroupMisses(task, enforceUsed, labelMap);

  const recoveryMode = completedTaskRecoveryMode({
    exitCode,
    payloadSubtype,
    fatalError,
    completed,
    verificationRequired,
    testsRun,
    testsPassed,
    verificationSummaryPresent,
    reviewRequired,
    reviewPresent,
    risksPresent,
    docsRequired,
    docsUpdated,
    category: task.category,
    nonDocChangedFiles,
    docPatternHits,
  });
  const timeoutRecovered = recoveryMode === 'timeout';
  const maxTurnsRecovered = recoveryMode === 'max_turns';
  // Surfaced as summary field `recovered_nonzero_exit`. Despite the legacy name,
  // this now means "recovered from ANY process-level error" — a nonzero claude
  // exit (timeout/max_turns) OR an exit-0 transport failure (runner_exception:
  // claude ran with empty/malformed stdout, or a spawn-level ENOENT/EACCES). All
  // downstream consumers treat it as a boolean "was recovered" flag, so an
  // exit-0 task with recovered_nonzero_exit=true is not a contradiction.
  const recoveredNonzeroExit = recoveryMode !== 'none';
  const effectiveTranscriptMisses = effectiveRequiredTranscriptMisses(requiredTranscriptMisses, {
    recoveredNonzeroExit,
  });

  let status = 'passed';
  const failures = classifyTaskFailures({
    exitCode,
    recoveredNonzeroExit,
    fatalError,
    completed,
    verificationRequired,
    testsRun,
    testsPassed,
    verificationSummaryPresent,
    reviewRequired,
    reviewPresent,
    risksPresent,
    docsRequired,
    docsUpdated,
    category: task.category,
    nonDocChangedFiles,
    docPatternHits,
    transcriptPatternHits,
    effectiveTranscriptMisses,
    missingRequiredUsedAgents,
    missingRequiredUsedAgentGroups,
    payloadHardStop: payloadHardStop,
  });
  if (failures.length) status = 'failed';

  const runtimeSeconds = Math.round((monotonicSeconds() - startedAt) * 1000) / 1000;
  const notes =
    `Claude model=${MODEL_NAME}. ` +
    `Exit code: ${exitCode}. ` +
    `Changed files: ${changedFiles.length ? changedFiles.join(', ') : 'none'}. ` +
    `Provider retry attempts: ${providerRetryAttempts}. ` +
    `Provider repaired by: ${providerRepairedBy}. ` +
    `Output budget retry attempts: ${outputBudgetRetryAttempts}. ` +
    `Output budget repaired by: ${outputBudgetRepairedBy}. ` +
    `Summary repair attempts: ${summaryRepairAttempts}. ` +
    `Summary repaired by: ${summaryRepairedBy}. ` +
    `Verification command: ${verificationLabel}. ` +
    `Timeout recovered: ${timeoutRecovered}. ` +
    `Max-turns recovered: ${maxTurnsRecovered}. ` +
    `Claude hard stop: ${payloadHardStop}. ` +
    `Transcript scanned: ${transcriptScanned}. ` +
    `Forbidden transcript hits: ${transcriptPatternHits.length ? transcriptPatternHits.join('; ') : 'none'}. ` +
    `Required assistant transcript scanned: ${requiredTranscriptScanned}. ` +
    `Required assistant transcript misses: ${requiredTranscriptMisses.length ? requiredTranscriptMisses.join('; ') : 'none'}. ` +
    `Used agent aliases: ${usedAgentAliases.length ? usedAgentAliases.join(', ') : 'none'}. ` +
    `Missing required used agents: ${missingRequiredUsedAgents.length ? missingRequiredUsedAgents.join(', ') : 'none'}. ` +
    `Missing required used agent groups: ${formatAgentGroupMisses(missingRequiredUsedAgentGroups)}. ` +
    `Failures: ${failures.length ? failures.join(', ') : 'none'}. ` +
    `Result: ${truncate(resultText, 700) || 'missing'}. ` +
    `Verification: ${truncate(verificationOutput, 700) || 'not required'}`;

  const result = buildResult({
    taskId: task.id,
    taskPath: TASK_PATH,
    status,
    completed,
    verificationRequired,
    testsRun,
    testsPassed,
    reviewRequired,
    reviewPresent,
    docsRequired,
    docsUpdated,
    runtimeSeconds,
    notes,
    category: task.category,
    changedFiles,
    nonDocChangedFiles,
    verificationSummaryPresent,
    risksPresent,
    exitCode,
    payloadSubtype,
    payloadStopReason,
    payloadHardStop,
    timeoutRecovered,
    maxTurnsRecovered,
    recoveredNonzeroExit,
    summaryRepairedBy,
    summaryRepairAttempts,
    permissionDenialsCount: permissionDenials.length,
    firstPermissionDenial: firstPermissionDenialSummary(permissionDenials),
    docPatternHits,
    transcriptScanned,
    transcriptPatternHits,
    requiredTranscriptScanned,
    requiredTranscriptMisses,
    usedAgentAliases,
    missingRequiredUsedAgents,
    missingRequiredUsedAgentGroups,
    observedAgentAliases,
    claimedAgentAliases,
    agentEvidenceByAlias,
    dispatchMode,
    fatalError,
    failures,
  });

  writeText(join(OUTPUT_DIR, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  writeText(
    join(OUTPUT_DIR, 'task-summary.txt'),
    buildTaskSummary({
      task,
      prompt,
      status,
      exitCode,
      changedFiles,
      failures,
      rawJson: rawStdout,
      payload,
      payloadSubtype,
      payloadStopReason,
      payloadHardStop,
      permissionDenials,
      resultText,
      verificationOutput,
      stderrText: rawStderr,
      debugLogText,
      patchText,
      transcriptScanned,
      transcriptPatternHits,
      requiredTranscriptScanned,
      requiredTranscriptMisses,
      usedAgentAliases,
      requiredUsedAgentMisses: missingRequiredUsedAgents,
      requiredUsedAgentGroupMisses: missingRequiredUsedAgentGroups,
      observedAgentAliases,
      claimedAgentAliases,
      dispatchMode,
    }),
  );
  if (fatalError) writeText(join(OUTPUT_DIR, 'runner-error.txt'), fatalError + '\n');
  return 0;
}

function monotonicSeconds() {
  const [sec, nan] = process.hrtime();
  return sec + nan / 1e9;
}

function _isMainModule() {
  try {
    return process.argv[1] && resolve(process.argv[1]) === _fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (_isMainModule()) {
  try {
    process.exitCode = main() || 0;
  } catch (err) {
    process.stderr.write(`bench_runner_claude_code: ${err.stack || err.message || err}\n`);
    process.exitCode = 1;
  }
}
