// Tests for transcript pattern validation logic in
// scripts/bench_runner_claude_code.mjs. Ported from the removed
// test/validators/test_transcript_pattern_validation.py. Exercises
// canonicalizeSubagentLabel and inferUsedAgentAliasesFromTranscript against the
// runner's fallback alias map (used when no plugins/.../assets/aliases.json is
// found), passed explicitly so the tests are hermetic — no env/cache coupling.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canonicalizeSubagentLabel,
  inferUsedAgentAliasesFromTranscript,
} from '../../scripts/bench_runner_claude_code.mjs';

// The fallback alias map the runner uses when assets/aliases.json is absent
// (see buildAgentLabelMap -> loadAliasesJson fallback). Mirrors it exactly so
// the test asserts the same canonicalization the runner applies in unit mode.
const FALLBACK_MAP = {
  e: 'e', explorer: 'e', explore: 'e',
  dbg: 'dbg', debugger: 'dbg', debug: 'dbg',
  cr: 'cr', 'code-reviewer': 'cr', 'code-review': 'cr', reviewer: 'cr',
};

test('canonicalizeSubagentLabel: known aliases canonicalize correctly', () => {
  assert.equal(canonicalizeSubagentLabel('code-reviewer', FALLBACK_MAP), 'cr');
  assert.equal(canonicalizeSubagentLabel('cr', FALLBACK_MAP), 'cr');
  assert.equal(canonicalizeSubagentLabel('explorer', FALLBACK_MAP), 'e');
  assert.equal(canonicalizeSubagentLabel('e', FALLBACK_MAP), 'e');
  assert.equal(canonicalizeSubagentLabel('debugger', FALLBACK_MAP), 'dbg');
  assert.equal(canonicalizeSubagentLabel('dbg', FALLBACK_MAP), 'dbg');
});

test('canonicalizeSubagentLabel: removed compatibility labels no longer resolve (ADR 0015)', () => {
  for (const raw of ['a', 'architect', 't', 'tester', 'bug', 'bugbuster', 'doc', 'docwriter', 'm', 'manager']) {
    assert.equal(canonicalizeSubagentLabel(raw, FALLBACK_MAP), null, `${raw} must not canonicalize to a role`);
  }
});

test('canonicalizeSubagentLabel: case insensitive', () => {
  assert.equal(canonicalizeSubagentLabel('Code-Reviewer', FALLBACK_MAP), 'cr');
  assert.equal(canonicalizeSubagentLabel('CODE_REVIEWER', FALLBACK_MAP), 'cr');
  assert.equal(canonicalizeSubagentLabel('EXPLORER', FALLBACK_MAP), 'e');
});

test('canonicalizeSubagentLabel: underscore to hyphen', () => {
  assert.equal(canonicalizeSubagentLabel('code_reviewer', FALLBACK_MAP), 'cr');
  assert.equal(canonicalizeSubagentLabel('code reviewer', FALLBACK_MAP), 'cr');
});

test('canonicalizeSubagentLabel: unknown labels return null', () => {
  assert.equal(canonicalizeSubagentLabel('unknown-agent', FALLBACK_MAP), null);
  assert.equal(canonicalizeSubagentLabel('', FALLBACK_MAP), null);
  assert.equal(canonicalizeSubagentLabel('   ', FALLBACK_MAP), null);
});

test('canonicalizeSubagentLabel: generic Task tool types return null', () => {
  assert.equal(canonicalizeSubagentLabel('general-purpose', FALLBACK_MAP), null);
  assert.equal(canonicalizeSubagentLabel('workflow-subagent', FALLBACK_MAP), null);
});

// ---------- inferUsedAgentAliasesFromTranscript ----------

function makePayload(text) {
  const dir = join(tmpdir(), `transcript-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, 'transcript.jsonl');
  const lines = text.trim().split('\n');
  const out = [];
  for (const line of lines) {
    out.push(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: line }] },
    }));
  }
  writeFileSync(transcript, out.join('\n') + '\n', 'utf-8');
  return { transcriptPath: transcript, dir };
}

function inferWithCleanup(text, labelMap = FALLBACK_MAP) {
  const { transcriptPath, dir } = makePayload(text);
  try {
    return inferUsedAgentAliasesFromTranscript({ transcript_path: transcriptPath }, labelMap);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('infer: detects @cr', () => {
  const result = inferWithCleanup('@cr no-op confirm · 0 tool uses');
  assert.ok(result.includes('cr'));
});

test('infer: detects @e', () => {
  const result = inferWithCleanup('@e no-op verify · 1 tool use');
  assert.ok(result.includes('e'));
});

test('infer: @explorer infers e via alias canonicalization', () => {
  const result = inferWithCleanup('@explorer traced the issue');
  assert.ok(result.includes('e'));
});

test('infer: @code-reviewer infers cr', () => {
  const result = inferWithCleanup('@code-reviewer confirmed the fix');
  assert.ok(result.includes('cr'));
});

test('infer: @debugger infers dbg', () => {
  const result = inferWithCleanup('@debugger reproduced the failure');
  assert.ok(result.includes('dbg'));
});

test('infer: removed legacy aliases infer nothing (ADR 0015)', () => {
  const result = inferWithCleanup('@nerd verified\n@toxic-senior confirmed\n@paranoid tested\n@m coordinated');
  assert.deepEqual(result, []);
});

test('infer: no false positive on email-like tokens', () => {
  const result = inferWithCleanup('Sent email to @example.com and checked @email-settings');
  assert.ok(!result.includes('e'));
  assert.ok(!result.includes('cr'));
});

test('infer: detects multiple aliases', () => {
  const result = inferWithCleanup('@explorer verified\n@code-reviewer confirmed\n@debugger tested');
  assert.deepEqual([...result].sort(), ['cr', 'dbg', 'e']);
});

test('infer: empty payload returns empty', () => {
  assert.deepEqual(inferUsedAgentAliasesFromTranscript(null, FALLBACK_MAP), []);
});

test('infer: payload with no messages returns empty', () => {
  assert.deepEqual(inferUsedAgentAliasesFromTranscript({}, FALLBACK_MAP), []);
});

test('infer: generic types not detected as aliases', () => {
  const result = inferWithCleanup('Launched general-purpose agent and workflow-subagent');
  assert.ok(!result.includes('general-purpose'));
  assert.ok(!result.includes('workflow-subagent'));
});

test('infer: a slash-skill load is not dispatch evidence (ADR 0015)', () => {
  assert.deepEqual(inferWithCleanup('Skill(/review)'), []);
  assert.deepEqual(inferWithCleanup('Skill(/test)'), []);
});

test('infer: dedupes alias and agent-name pattern (same role once)', () => {
  const result = inferWithCleanup('@e explored\nexplorer(code)');
  assert.equal(result.filter((a) => a === 'e').length, 1);
});