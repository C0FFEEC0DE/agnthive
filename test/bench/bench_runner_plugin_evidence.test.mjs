// Tests for the ADR-0009/0010/0012 structured plugin-state evidence layer in
// scripts/bench_runner_claude_code.mjs (plan task 09). Seeds REAL plugin event
// stores via plugins/agnthive/modules/state.mjs appendEvent/readEvents so the
// runner's shared-reader path is exercised end to end. Node stdlib only.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import {
  pluginStateCandidateRoots,
  readSessionPluginState,
  mergePluginStateAgentEvidence,
  pluginStateFoundSummary,
  outcomeLivePredicates,
  resolveEvidenceFlagField,
  evaluateOutcomeLivePredicates,
  scrubSpawnEnv,
  buildResult,
} from '../../scripts/bench_runner_claude_code.mjs';
import {
  rolesFromPluginState,
  registryRunningRoles,
  verificationEvidenceFromStateRecords,
  reviewEvidenceFromStateRecords,
} from '../../scripts/bench/lib.mjs';
import { statePaths, appendEvent } from '../../plugins/agnthive/modules/state.mjs';
import { classifyTaskFailures } from '../../scripts/bench_runner_claude_code.mjs';

const LABEL_MAP = {
  a: 'a', architect: 'a', e: 'e', explorer: 'e', t: 't', tester: 't',
  cr: 'cr', 'code-reviewer': 'cr', bug: 'bug', bugbuster: 'bug',
  dbg: 'dbg', debugger: 'dbg', doc: 'doc', docwriter: 'doc', m: 'm', manager: 'm',
};
const canon = (raw) => {
  const n = String(raw ?? '').trim().replace(/^@/, '').toLowerCase().replace(/[\s_]+/g, '-');
  return LABEL_MAP[n] || null;
};


// Minimal bench task shape mirroring the runner's task reader (agent-inventory parity).
function baseTask(overrides = {}) {
  return {
    id: 't1',
    category: 'feature',
    fixture: 'node-app',
    review_required: false,
    docs_required: false,
    verification_required: false,
    prompt: 'Add a hello function',
    success_criteria: ['hello() returns "hello"'],
    must_not: ['do not touch unrelated files'],
    required_used_agents: [],
    required_used_agent_groups: [],
    forbidden_doc_patterns: [],
    forbidden_transcript_patterns: [],
    required_transcript_patterns: [],
    ...overrides,
  };
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'bench-evidence-'));
}

// Seeds a real append-only event store for a session and returns its paths.
// `records` is an array of [type, payload] event tuples applied in order.
function seedSessionStore(dataRoot, sessionId, events) {
  const paths = statePaths(dataRoot, sessionId);
  for (const [type, payload] of events) appendEvent(paths, type, payload);
  return paths;
}

const baseSessionEvents = (workdir) => ([
  ['init', { session_id: 'sess-1', cwd: workdir, transcript_path: '' }],
  ['set', { field: 'revision', value: 3 }],
]);

test('verificationEvidenceFromStateRecords: revision-scoped pass is valid', () => {
  const ev = verificationEvidenceFromStateRecords(
    [{ id: 'v1', kind: 'tests', command: 'npm run test', status: 'passed', startedRevision: 3, completedRevision: 3, cwd: '/w' }],
    { currentRevision: 3, workdir: '/w' },
  );
  assert.equal(ev.current, true);
  assert.equal(ev.passed_record_count, 1);
  assert.deepEqual(ev.passed_record_ids, ['v1']);
  assert.equal(ev.has_records, true);
});

test('verification evidence: stale/pending/failed/foreign-cwd records rejected', () => {
  const stale = verificationEvidenceFromStateRecords(
    [{ id: 'v1', status: 'passed', startedRevision: 2, completedRevision: 3, cwd: '/w' }],
    { currentRevision: 3, workdir: '/w' },
  );
  assert.equal(stale.current, false);
  assert.equal(stale.stale_count, 1);

  const notCurrent = verificationEvidenceFromStateRecords(
    [
      { id: 'p1', status: 'pending', startedRevision: 3, completedRevision: null, cwd: '/w' },
      { id: 'f1', status: 'failed', startedRevision: 3, completedRevision: 3, cwd: '/w' },
    ],
    { currentRevision: 3, workdir: '/w' },
  );
  assert.equal(notCurrent.current, false);
  assert.equal(notCurrent.pending_count, 1);
  assert.equal(notCurrent.failed_count, 1);

  const foreign = verificationEvidenceFromStateRecords(
    [{ id: 'v1', status: 'passed', startedRevision: 3, completedRevision: 3, cwd: '/other-tree' }],
    { currentRevision: 3, workdir: '/w' },
  );
  assert.equal(foreign.current, false);
  assert.equal(foreign.foreign_cwd_count, 1);
});

test('verification evidence: no-cwd legacy record accepted and flagged; empty list has no records', () => {
  const legacy = verificationEvidenceFromStateRecords(
    [{ id: 'v1', status: 'passed', startedRevision: 3, completedRevision: 3 }],
    { currentRevision: 3, workdir: '/w' },
  );
  assert.equal(legacy.current, true);
  assert.equal(legacy.unrecorded_cwd_count, 1);

  const empty = verificationEvidenceFromStateRecords([], { currentRevision: 3, workdir: '/w' });
  assert.equal(empty.has_records, false);
  assert.equal(empty.current, false);
  assert.equal(empty.source, 'plugin_state');
});

test('reviewEvidenceFromStateRecords: completed current-revision reviewer record valid', () => {
  const ev = reviewEvidenceFromStateRecords(
    [{ id: 'r1', agentId: 'ag1', role: 'cr', status: 'completed', revision: 3 }],
    { currentRevision: 3 },
  );
  assert.equal(ev.current, true);
  assert.deepEqual(ev.completed_record_ids, ['r1']);

  const wrongRole = reviewEvidenceFromStateRecords(
    [{ id: 'r2', role: 't', status: 'completed', revision: 3 }],
    { currentRevision: 3 },
  );
  assert.equal(wrongRole.current, false);
  assert.equal(wrongRole.wrong_role_count, 1);

  const stale = reviewEvidenceFromStateRecords(
    [{ id: 'r3', role: 'cr', status: 'completed', revision: 2 }],
    { currentRevision: 3 },
  );
  assert.equal(stale.current, false);
  assert.equal(stale.stale_count, 1);
});

test('rolesFromPluginState: registry + subagents_started merged, foreign filtered', () => {
  const state = {
    agents: {
      agent_1: { role: 'cr', status: 'completed', starts: 1 },
      agent_2: { role: null, status: 'unknown', starts: 1 },
      agent_3: { role: 't', status: 'running', starts: 1 },
    },
    subagents_started: ['bug', 'general-purpose'],
  };
  assert.deepEqual(rolesFromPluginState(state, canon), ['bug', 'cr', 't']);
  assert.deepEqual(rolesFromPluginState(null, canon), []);
  assert.deepEqual(rolesFromPluginState({}, canon), []);
});

test('registryRunningRoles: running reviewer surfaced', () => {
  const state = {
    agents: {
      ag1: { role: 'cr', status: 'completed', starts: 1 },
      ag2: { role: 't', status: 'running', starts: 1 },
    },
  };
  assert.deepEqual(registryRunningRoles(state), ['t']);
  assert.deepEqual(registryRunningRoles({}), []);
});

test('pluginStateCandidateRoots: ordering, dedupe, isolation first', () => {
  const roots = pluginStateCandidateRoots({
    outputDir: '/tmp/bench-out',
    env: { BENCH_PLUGIN_DATA_ROOTS: '/tmp/r1\n/tmp/r2;/tmp/bench-out/plugin-data', CLAUDE_PLUGIN_DATA: '/tmp/outer' },
    home: '/tmp/home',
  });
  assert.deepEqual(roots.map((r) => r.kind), ['bench_isolated', 'env_list', 'env_list', 'data_dir_env', 'home_fallback']);
  // /tmp/bench-out/plugin-data listed twice (isolated + env_list) is deduped,
  // keeping the earlier kind. The roots are resolve()d by production code, so
  // win32 adds a drive prefix (build the expectation with the same primitive).
  assert.equal(roots.filter((r) => r.root === join(resolvePath('/tmp/bench-out'), 'plugin-data')).length, 1);
  assert.equal(roots[0].kind, 'bench_isolated');
});

test('readSessionPluginState: found in candidate root with strict session match', () => {
  const tmp = makeTempDir();
  try {
    const dataRoot = join(tmp, 'plugin-data');
    seedSessionStore(dataRoot, 'sess-1', baseSessionEvents('/w'));
    const read = readSessionPluginState('sess-1', { roots: [{ kind: 'bench_isolated', root: dataRoot }] });
    assert.equal(read.found, true);
    assert.equal(read.root_kind, 'bench_isolated');
    assert.equal(read.state.session_id, 'sess-1');
    assert.equal(read.state.revision, 3);
    assert.equal(read.raw_event_files, 2);
    assert.equal(read.parsed_events, 2);
    assert.equal(read.truncated_events, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readSessionPluginState: drifted dir-vs-stored session id skipped with diagnostic', () => {
  // F03-style wrong-session fixture: the store DIRECTORY is named for the
  // requested session, but the replayed state carries a different stored
  // session_id — the strict match must skip it, never credit foreign state.
  const tmp = makeTempDir();
  try {
    const dataRoot = join(tmp, 'plugin-data');
    const paths = statePaths(dataRoot, 'sess-1');
    appendEvent(paths, 'init', { session_id: 'other-session', cwd: '/w' });
    appendEvent(paths, 'set', { field: 'revision', value: 9 });
    const read = readSessionPluginState('sess-1', { roots: [{ kind: 'bench_isolated', root: dataRoot }] });
    assert.equal(read.found, false);
    assert.equal(read.reason, 'no-plugin-state-for-session');
    assert.ok(read.diagnostics.some((d) => d.includes('session mismatch')), JSON.stringify(read.diagnostics));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readSessionPluginState: missing session id and empty roots never guess', () => {
  assert.equal(readSessionPluginState('').found, false);
  assert.equal(readSessionPluginState('').reason, 'missing-session-id');
  assert.equal(readSessionPluginState('no-session').found, false);
  const none = readSessionPluginState('sess-x', { roots: [] });
  assert.equal(none.found, false);
  assert.equal(none.reason, 'no-plugin-state-for-session');
});

test('readSessionPluginState: truncated (corrupt) event records counted as diagnostics', () => {
  const tmp = makeTempDir();
  try {
    const dataRoot = join(tmp, 'plugin-data');
    const paths = seedSessionStore(dataRoot, 'sess-1', baseSessionEvents('/w'));
    writeFileSync(join(paths.eventsDir, '0000000003.json'), '{"truncated": oops');
    const read = readSessionPluginState('sess-1', { roots: [{ kind: 'bench_isolated', root: dataRoot }] });
    assert.equal(read.found, true);
    assert.equal(read.raw_event_files, 3);
    assert.equal(read.parsed_events, 2);
    assert.equal(read.truncated_events, 1);
    assert.ok(read.diagnostics.some((d) => d.includes('truncated')), JSON.stringify(read.diagnostics));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('structured evidence from a seeded run: verification + roles + review gate', () => {
  const tmp = makeTempDir();
  try {
    const workdir = join(tmp, 'w');
    mkdirSync(workdir, { recursive: true });
    const dataRoot = join(tmp, 'plugin-data');
    seedSessionStore(dataRoot, 'sess-1', [
      ...baseSessionEvents(workdir),
      ['append_unique', { field: 'subagents_started', value: 'bug' }],
      ['map_set', { mapField: 'agents', key: 'ag-bug', value: { role: 'bug', status: 'completed', starts: 1 } }],
      ['append', { field: 'verification', value: { id: 'v1', status: 'passed', startedRevision: 3, completedRevision: 3, cwd: workdir } }],
      ['append', { field: 'review_results', value: { id: 'r1', role: 'cr', status: 'completed', revision: 3 } }],
    ]);
    const read = readSessionPluginState('sess-1', { roots: [{ kind: 'bench_isolated', root: dataRoot }] });
    assert.equal(read.found, true);
    const roles = rolesFromPluginState(read.state, canon);
    assert.deepEqual(roles, ['bug']); // cr only appears in review_results, not the registry
    const verificationEvidence = verificationEvidenceFromStateRecords(read.state.verification, {
      currentRevision: 3, workdir,
    });
    assert.equal(verificationEvidence.current, true);
    const reviewEvidence = reviewEvidenceFromStateRecords(read.state.review_results, { currentRevision: 3 });
    assert.equal(reviewEvidence.current, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('classification: evidence-missing codes wired per ADR-0009', () => {
  // Records exist but none valid -> failure codes fire.
  const strict = classifyTaskFailures({
    exitCode: 0,
    completed: true,
    verificationRequired: true,
    testsRun: true,
    testsPassed: true,
    verificationSummaryPresent: true,
    reviewRequired: true,
    reviewPresent: true,
    risksPresent: true,
    docsRequired: false,
    docsUpdated: false,
    category: 'feature',
    nonDocChangedFiles: [],
    docPatternHits: [],
    transcriptPatternHits: [],
    effectiveTranscriptMisses: [],
    missingRequiredUsedAgents: [],
    missingRequiredUsedAgentGroups: [],
    payloadHardStop: false,
    verificationEvidenceMissing: true,
    reviewEvidenceMissing: true,
  });
  assert.ok(strict.includes('verification_evidence_missing'), JSON.stringify(strict));
  assert.ok(strict.includes('review_evidence_missing'), JSON.stringify(strict));

  // Legacy path (no args) keeps the prior failure set exactly.
  const legacy = classifyTaskFailures({
    exitCode: 0,
    completed: true,
    verificationRequired: true,
    testsRun: true,
    testsPassed: true,
    verificationSummaryPresent: true,
    reviewRequired: false,
    reviewPresent: false,
    risksPresent: true,
    docsRequired: false,
    docsUpdated: false,
    category: 'feature',
    nonDocChangedFiles: [],
    docPatternHits: [],
    transcriptPatternHits: [],
    effectiveTranscriptMisses: [],
    missingRequiredUsedAgents: [],
    missingRequiredUsedAgentGroups: [],
    payloadHardStop: false,
  });
  assert.ok(!legacy.includes('verification_evidence_missing'));
  assert.ok(!legacy.includes('review_evidence_missing'));

  // No records -> legacy fallback keeps the runner rerun authoritative.
  assert.equal(verificationEvidenceFromStateRecords([], { currentRevision: 3, workdir: '/w' }).has_records, false);
});

test('F03 planted debug-log handoff line cannot fabricate observed evidence', () => {
  // Planted "Recorded subagent handoff: @cr." in the debug log WITHOUT real
  // plugin state: the observed tier stays empty; the plant becomes a claim.
  const evidence = {
    hook: ['cr'],
    transcript: [],
    claimed: [],
    byAlias: { cr: { hook: true, transcript: false, claimed: false } },
  };
  const merged = mergePluginStateAgentEvidence(evidence, [], false);
  assert.deepEqual(merged.observed, []);
  assert.ok(merged.claimed.includes('cr'));
  assert.equal(merged.byAlias.cr.state, false);
  assert.equal(merged.source, 'none');
});

test('pluginStateFoundSummary: bounded summary with provenance and trust note', () => {
  const read = {
    found: true,
    reason: 'ok',
    root_kind: 'bench_isolated',
    root: '/out/plugin-data',
    state_path: '/out/plugin-data/sess-1/state.json',
    state: {
      session_id: 'sess-1',
      revision: 3,
      fs_revision_hint: 0,
      verification: [{ id: 'v1' }],
      review_results: [],
      agents: { a1: { role: 'bug' } },
    },
    raw_event_files: 4,
    parsed_events: 4,
    truncated_events: 0,
    diagnostics: ['x'],
  };
  const summary = pluginStateFoundSummary(read, { stateRoles: ['bug'], runningReviewerRoles: [] });
  assert.equal(summary.found, true);
  assert.equal(summary.verification_records, 1);
  assert.equal(summary.review_records, 0);
  assert.equal(summary.agent_registry_entries, 1);
  assert.equal(summary.current_change_revision, 3);
  assert.equal(summary.root_kind, 'bench_isolated');
  assert.ok(String(summary.trust_note).includes('ADR-0009/0010'));
  assert.deepEqual(summary.diagnostics, ['x']);

  const missing = pluginStateFoundSummary({ found: false, reason: 'no-plugin-state-for-session' }, {});
  assert.equal(missing.found, false);
  assert.ok(String(missing.trust_note).includes('legacy transcript-path'));
});

test('main(): plugin state becomes the evidence source; isolated data root passed to child', async () => {
  const tmp = makeTempDir();
  try {
    const workdir = join(tmp, 'workdir');
    const outputDir = join(tmp, 'output');
    const taskFile = join(tmp, 'task.json');
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    writeFileSync(taskFile, JSON.stringify(baseTask({ verification_required: true, id: 'stub-evidence' })));
    const fakeResultText =
      'Did the work.\n\nVerification status: passed - npm run test completed successfully.\n' +
      'Review outcome: not required - no review required.\n' +
      'Remaining risks: none';
    const fakeStdout = JSON.stringify({
      result: fakeResultText, subtype: 'result', stop_reason: 'end_turn', session_id: 'sess-bench-1',
    });
    // Seed the per-run evidence index BEFORE the run: a session store with a
    // revision-scoped passed verification record and a real dispatch role.
    const dataRoot = join(outputDir, 'plugin-data');
    seedSessionStore(dataRoot, 'sess-bench-1', [
      ['init', { session_id: 'sess-bench-1', cwd: workdir, transcript_path: '' }],
      ['set', { field: 'revision', value: 2 }],
      ['append_unique', { field: 'subagents_started', value: 't' }],
      ['append', { field: 'verification', value: { id: 'v1', status: 'passed', startedRevision: 2, completedRevision: 2, cwd: workdir } }],
    ]);
    const spawnCalls = [];
    const stub = (bin, args, opts) => {
      spawnCalls.push({ bin, args: [...args], opts });
      if (bin === 'npm') return { status: 0, stdout: '1 passed', stderr: '' };
      writeFileSync(join(workdir, 'src.js'), 'export const hello = () => "hello";\n');
      return { status: 0, stdout: fakeStdout, stderr: '' };
    };
    const env = {
      ...process.env,
      BENCH_REPO_ROOT: join(import.meta.dirname, '..', '..'),
      BENCH_TASK_FILE: taskFile,
      BENCH_WORKDIR: workdir,
      BENCH_OUTPUT_DIR: outputDir,
      BENCH_FIXTURE_DIR: workdir,
      OLLAMA_MODEL: 'stub-model',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '',
    };
    const oldEnv = { ...process.env };
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    try {
      const mod = await import(`../../scripts/bench_runner_claude_code.mjs?ev=${Date.now()}`);
      mod.__setSpawnSync(stub);
      const rc = mod.main();
      assert.equal(rc, 0);
      const result = JSON.parse(readFileSync(join(outputDir, 'result.json'), 'utf-8'));
      assert.equal(result.status, 'passed');
      assert.equal(result.evidence_source, 'plugin_state');
      assert.equal(result.evidence_provenance, 'bench_isolated');
      assert.equal(result.plugin_state.found, true);
      assert.equal(result.verification_evidence.current, true);
      assert.ok(result.state_agent_roles.includes('t'), JSON.stringify(result.state_agent_roles));
      assert.equal(result.observed_agent_aliases_source, 'plugin_state');
      assert.ok(result.observed_agent_aliases.includes('t'));
      assert.ok(result.agent_evidence_by_alias.t.state === true);
      // The child env carried the per-run evidence index.
      const claudeCall = spawnCalls.find((c) => c.bin === 'claude');
      assert.equal(claudeCall.opts.env.CLAUDE_PLUGIN_DATA, join(outputDir, 'plugin-data'));
      const evidence = JSON.parse(readFileSync(join(outputDir, 'evidence.json'), 'utf-8'));
      assert.equal(evidence.schema, 'agnthive.bench-evidence/1');
      assert.equal(evidence.provenance, 'bench_isolated');
      assert.equal(evidence.source, 'plugin_state');
      // task-summary.txt records the structured evidence surface.
      const taskSummary = readFileSync(join(outputDir, 'task-summary.txt'), 'utf-8');
      assert.ok(taskSummary.includes('Evidence source: plugin_state'), taskSummary);
      assert.ok(taskSummary.includes('Verification evidence (plugin state): current-revision passed'), taskSummary);
    } finally {
      process.env = oldEnv;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('outcomeLivePredicates filters to evaluate_in live only', () => {
  const p = (id, kind, evaluateIn) => (
    { id, kind, evaluate_in: evaluateIn, path: 'a.mjs', pattern: 'x' });
  const task = {
    id: 'outcome-x', expected_outcome: {
      predicates: [
        p('mock-one', 'initial_file_matches', 'mock'),
        p('live-exists', 'file_exists', 'live'),
        p('live-match', 'file_matches', 'live'),
        p('live-unknown-pred', 'quantum_check', 'live'),
        { kind: 'file_exists', evaluate_in: 'live' },
      ],
    },
  };
  const live = outcomeLivePredicates(task);
  assert.deepEqual(live.map((x) => x.id), ['live-exists', 'live-match', 'live-unknown-pred']);
  assert.ok(!live.some((x) => x.id === 'live-no-id'));
});

test('evaluateOutcomeLivePredicates: file predicates match end state in the workdir', () => {
  const tmp = makeTempDir();
  try {
    const workdir = join(tmp, 'workdir');
    mkdirSync(join(workdir, 'src'), { recursive: true });
    writeFileSync(join(workdir, 'src', 'a.mjs'), 'export const v1 = 1;\n');
    writeFileSync(join(workdir, 'docs.md'), '# kept\n');
    const task = {
      id: 'outcome-y', fixture: 'node-app', suite: 'outcomes',
      seed_files: [{ path: 'docs.md', source: 'seeds/x/docs.md', sha256: '' }],
      expected_outcome: {
        predicates: [
          { id: 'exists-ok', kind: 'file_exists', evaluate_in: 'live', path: 'src/a.mjs' },
          { id: 'exists-missing', kind: 'file_exists', evaluate_in: 'live', path: 'src/missing.mjs' },
          { id: 'match-ok', kind: 'file_matches', evaluate_in: 'live', path: 'src/a.mjs', pattern: 'export const v1' },
          { id: 'notmatch-ok', kind: 'file_not_matches', evaluate_in: 'live', path: 'src/a.mjs', pattern: 'TODO' },
          { id: 'notmatch-fail', kind: 'file_not_matches', evaluate_in: 'live', path: 'src/a.mjs', pattern: 'v1' },
          { id: 'unchanged-fixture', kind: 'file_unchanged', evaluate_in: 'live', path: 'docs.md', base: 'fixture' },
          { id: 'unchanged-seed', kind: 'file_unchanged', evaluate_in: 'live', path: 'docs.md', base: 'seed' },
        ],
      },
    };
    // fixture base at bench/fixtures/<fixture>/docs.md (identical bytes) and
    // seed base at bench/tasks/outcomes/seeds/x/docs.md (differs).
    mkdirSync(join(tmp, 'bench', 'fixtures', 'node-app'), { recursive: true });
    writeFileSync(join(tmp, 'bench', 'fixtures', 'node-app', 'docs.md'), '# kept\n');
    mkdirSync(join(tmp, 'bench', 'tasks', 'outcomes', 'seeds', 'x'), { recursive: true });
    writeFileSync(join(tmp, 'bench', 'tasks', 'outcomes', 'seeds', 'x', 'docs.md'), '# changed\n');
    const ev = evaluateOutcomeLivePredicates(task, {
      repoRoot: tmp, workdir, resultText: 'did things',
    });
    const byId = Object.fromEntries(ev.results.map((r) => [r.id, r]));
    assert.equal(byId['exists-ok'].result, 'passed');
    assert.equal(byId['exists-missing'].result, 'failed');
    assert.equal(byId['match-ok'].result, 'passed');
    assert.equal(byId['notmatch-ok'].result, 'passed');
    assert.equal(byId['notmatch-fail'].result, 'failed');
    assert.equal(byId['unchanged-fixture'].result, 'passed');
    assert.equal(byId['unchanged-seed'].result, 'failed');
    assert.equal(ev.findings_evidence, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveEvidenceFlagField: ADR-0009 vocabulary incl. revision-scoped current', () => {
  const state = {
    cwd: '/w', revision: 3,
    verification: [
      { id: 'v0', status: 'failed', startedRevision: 2, completedRevision: 2 },
      { id: 'v1', status: 'passed', startedRevision: 3, completedRevision: 3 },
    ],
    review_results: [{ id: 'r1', status: 'completed', revision: 3 }],
    docs_status: 'updated', workflow_profile: 'lean', restored_task_seq: 4,
    fs_revision_hint: 0,
  };
  const cur = resolveEvidenceFlagField(state, 'verification.current');
  assert.equal(cur.found, true);
  assert.equal(cur.value, true);
  const latest = resolveEvidenceFlagField(state, 'verification.latest.status');
  assert.equal(latest.value, 'passed');
  assert.equal(resolveEvidenceFlagField(state, 'docs_status').value, 'updated');
  assert.equal(resolveEvidenceFlagField(state, 'revision').value, 3);
  assert.equal(resolveEvidenceFlagField(state, 'workflow_profile').value, 'lean');
  assert.equal(resolveEvidenceFlagField(state, 'restored_task_seq').value, 4);
  assert.equal(resolveEvidenceFlagField(state, 'agents.total').found, false);
  const noV = resolveEvidenceFlagField(state, 'verification.latest.status');
  assert.equal(noV.found, true); // resolves against the state above
  const empty = resolveEvidenceFlagField({}, 'verification.current');
  assert.deepEqual([empty.found, empty.value], [true, false]);
  const unknown = resolveEvidenceFlagField(state, 'quantum.field');
  assert.deepEqual([unknown.found, unknown.value], [false, undefined]);
});

test('evaluateOutcomeLivePredicates: evidence flags, commands, scope, findings', () => {
  const tmp = makeTempDir();
  try {
    const workdir = join(tmp, 'workdir');
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, 'keep.mjs'), 'same\n');
    const state = {
      cwd: workdir, revision: 2, subagent_start_count: 2,
      verification: [{ id: 'v1', status: 'passed', startedRevision: 2, completedRevision: 2, cwd: workdir }],
    };
    const task = {
      id: 'outcome-z', suite: 'outcomes', fixture: 'node-app',
      ground_truth: {
        findings: [
          { id: 'mf-1', material: true, report_pattern: 'order of operations fixed' },
          { id: 'mf-2', material: true, report_pattern: 'no\\s+eval\\(' },
          { id: 'mf-noise', material: false, report_pattern: 'refactored everything' },
        ],
      },
      expected_outcome: { predicates: [
        { id: 'flag-ver-current', kind: 'evidence_flag', evaluate_in: 'live', field: 'verification.current', op: 'equals', equals: true },
        { id: 'flag-ver-status', kind: 'evidence_flag', evaluate_in: 'live', field: 'verification.latest.status', op: 'equals', equals: 'passed' },
        { id: 'flag-unknown-field', kind: 'evidence_flag', evaluate_in: 'live', field: 'agents.total', op: 'exists' },
        { id: 'flag-absent', kind: 'evidence_flag', evaluate_in: 'live', field: 'docs_status', op: 'absent' },
        { id: 'flag-gte', kind: 'evidence_flag', evaluate_in: 'live', field: 'revision', op: 'gte', equals: 2 },
        { id: 'flag-lte-fail', kind: 'evidence_flag', evaluate_in: 'live', field: 'revision', op: 'lte', equals: 1 },
        { id: 'cmd-ok', kind: 'commands_pass', evaluate_in: 'live', commands: ['node -v'] },
        { id: 'cmd-fail', kind: 'commands_pass', evaluate_in: 'live', commands: ['node nonexist-module.mjs'] },
        { id: 'scope-ok', kind: 'changed_paths_within', evaluate_in: 'live', allow: ['src/**', 'docs/*.md', 'other/**'] },
        { id: 'scope-fail', kind: 'changed_paths_within', evaluate_in: 'live', allow: ['src/**'] },
        { id: 'scope-none', kind: 'changed_paths_within', evaluate_in: 'live', allow: [] },
        { id: 'findings-ok', kind: 'findings_cover', evaluate_in: 'live', min_matches: 1 },
        { id: 'findings-tight', kind: 'findings_cover', evaluate_in: 'live', min_matches: 3 },
        { id: 'unknown-kind', kind: 'quantum_check', evaluate_in: 'live' },
      ] },
    };
    const ev = evaluateOutcomeLivePredicates(task, {
      repoRoot: tmp,
      workdir,
      changedFiles: ['src/fixed.mjs', 'docs/notes.md', 'other/loose.mjs'],
      resultText: 'order of operations fixed; eval( gone: no eval( remains.',
      state,
      transcriptText: '',
    });
    const byId = Object.fromEntries(ev.results.map((r) => [r.id, r]));
    assert.equal(byId['flag-ver-current'].result, 'passed');
    assert.equal(byId['flag-ver-status'].result, 'passed');
    // Unknown evidence field: predicate FAILURE, never a silent skip.
    assert.equal(byId['flag-unknown-field'].result, 'failed');
    assert.equal(byId['flag-absent'].result, 'passed');
    assert.equal(byId['flag-gte'].result, 'passed');
    assert.equal(byId['flag-lte-fail'].result, 'failed');
    assert.equal(byId['cmd-ok'].result, 'passed');
    assert.equal(byId['cmd-fail'].result, 'failed');
    assert.equal(byId['scope-ok'].result, 'passed');
    assert.equal(byId['scope-fail'].result, 'failed');
    assert.equal(byId['scope-none'].result, 'failed');
    assert.equal(byId['findings-ok'].result, 'passed');
    assert.equal(byId['findings-tight'].result, 'failed');
    assert.equal(byId['unknown-kind'].result, 'unverified');
    assert.deepEqual(ev.findings_evidence, {
      matched_material_ids: ['mf-1', 'mf-2'],
      claimed_total: 2,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildResult carries outcome pass-through keys; honest nulls when absent', () => {
  const base = { taskId: 't', taskPath: 'x', status: 'passed', notes: 'n' };
  const bare = buildResult(base);
  assert.equal(bare.rep, null);
  assert.equal(bare.turns, null);
  assert.equal(bare.token_usage, null);
  assert.equal(bare.cost_usd, null);
  assert.equal(bare.cost_source, null);
  assert.equal(bare.predicate_results, null);
  assert.equal(bare.findings_evidence, null);
  assert.equal(bare.dispatch_count, null);
  const full = buildResult({ ...base, rep: 2, turns: 4, costUsd: 0.02, costSource: 'provider',
    tokenUsage: { input: 10, output: 5, cache_read: 2, cache_write: 1 },
    predicateResults: { a: { result: 'passed', detail: 'd' } },
    findingsEvidence: { matched_material_ids: ['m1'], claimed_total: 3 },
    dispatchCount: 1 });
  assert.equal(full.rep, 2);
  assert.equal(full.turns, 4);
  assert.deepEqual(full.token_usage, { input: 10, output: 5, cache_read: 2, cache_write: 1 });
  assert.equal(full.cost_usd, 0.02);
  assert.equal(full.cost_source, 'provider');
  assert.deepEqual(full.predicate_results, { a: { result: 'passed', detail: 'd' } });
  assert.deepEqual(full.findings_evidence, { matched_material_ids: ['m1'], claimed_total: 3 });
  assert.equal(full.dispatch_count, 1);
  // Non-integer sources (e.g. BENCH_REP "x" or float cost junk) stay null.
  assert.equal(buildResult({ ...base, rep: 'x', costUsd: 'free' }).cost_usd, null);
  assert.equal(buildResult({ ...base, rep: 'x' }).rep, null);
});

test('main(): outcome pass-through keys from payload + seeded state; mock e2e', async () => {
  const tmp = makeTempDir();
  try {
    const workdir = join(tmp, 'workdir');
    const outputDir = join(tmp, 'output');
    const taskFile = join(tmp, 'task.json');
    mkdirSync(workdir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(workdir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    writeFileSync(taskFile, JSON.stringify(baseTask({
      id: 'outcome-passthrough', verification_required: true,
      required_used_agent_groups: [{ any_of: ['t'] }],
    })));
    const fakeResultText =
      'Did the work.\n\nVerification status: passed - npm run test completed successfully.\n' +
      'Review outcome: not required - no review required.\n' +
      'Remaining risks: none';
    const fakeStdout = JSON.stringify({
      result: fakeResultText, subtype: 'result', stop_reason: 'end_turn',
      session_id: 'sess-bench-1', num_turns: 4,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
      total_cost_usd: 0.02,
    });
    seedSessionStore(join(outputDir, 'plugin-data'), 'sess-bench-1', [
      ['init', { session_id: 'sess-bench-1', cwd: workdir, transcript_path: '' }],
      ['increment', { field: 'subagent_start_count' }],
      ['append_unique', { field: 'subagents_started', value: 't' }],
      ['append', { field: 'verification', value: { id: 'v1', status: 'passed', startedRevision: 0, completedRevision: 0 } }],
    ]);
    const spawnCalls = [];
    const stub = (bin, args, opts) => {
      spawnCalls.push({ bin, args: [...args], opts });
      if (bin === 'npm') return { status: 0, stdout: 'jest passed', stderr: '' };
      writeFileSync(join(workdir, 'src.js'), 'export const hello = () => "hello";\n');
      return { status: 0, stdout: fakeStdout, stderr: '' };
    };
    const env = {
      ...process.env,
      BENCH_REPO_ROOT: join(import.meta.dirname, '..', '..'),
      BENCH_TASK_FILE: taskFile,
      BENCH_WORKDIR: workdir,
      BENCH_OUTPUT_DIR: outputDir,
      BENCH_FIXTURE_DIR: workdir,
      OLLAMA_MODEL: 'stub-model',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '',
      BENCH_REP: '2',
    };
    const oldEnv = { ...process.env };
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    try {
      const mod = await import(`../../scripts/bench_runner_claude_code.mjs?ev2=${Date.now()}`);
      mod.__setSpawnSync(stub);
      const rc = mod.main();
      assert.equal(rc, 0);
      const result = JSON.parse(readFileSync(join(outputDir, 'result.json'), 'utf-8'));
      assert.equal(result.status, 'passed');
      assert.equal(result.rep, 2);
      assert.equal(result.turns, 4);
      assert.deepEqual(result.token_usage, { input: 10, output: 5, cache_read: 2, cache_write: 1 });
      assert.equal(result.cost_usd, 0.02);
      assert.equal(result.cost_source, 'provider');
      // dispatch evidence from the seeded structured state, never transcript text
      assert.equal(result.dispatch_count, 1);
      // non-outcome task: predicate/findings keys stay null (honest absence)
      assert.equal(result.predicate_results, null);
      assert.equal(result.findings_evidence, null);
      assert.ok(result.agent_evidence_by_alias.t.state === true);
      // BENCH_ARM/BENCH_REP: arm stays transparent (emitter reads it); rep recorded
      assert.ok(!('arm' in result));
      assert.ok(result.notes.includes('Evidence source: plugin_state.'));
    } finally {
      process.env = oldEnv;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- BLOCK 3: commands_pass exec hardening (@cr 0.4.0) ----------
test('scrubSpawnEnv strips provider secrets, keeps PATH-like vars', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/x',
    ANTHROPIC_AUTH_TOKEN: 'sk-ant-secret',
    ANTHROPIC_API_KEY: 'sk-ant-key',
    OLLAMA_API_KEY: 'ollama-secret',
    MYPROVIDER_TOKEN: 'p-token',
    MYPROVIDER_API_KEY: 'p-key',
    MYPROVIDER_KEY: 'p-key2',
    NOT_A_SECRET_VAR: 'keep-me',
  };
  const out = scrubSpawnEnv(env);
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.HOME, '/home/x');
  assert.equal(out.NOT_A_SECRET_VAR, 'keep-me');
  assert.equal(out.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(out.ANTHROPIC_API_KEY, undefined);
  assert.equal(out.OLLAMA_API_KEY, undefined);
  assert.equal(out.MYPROVIDER_TOKEN, undefined);
  assert.equal(out.MYPROVIDER_API_KEY, undefined);
  assert.equal(out.MYPROVIDER_KEY, undefined);
});

test('commands_pass: non-allowlisted program reports unverified without spawning', () => {
  const tmp = makeTempDir();
  try {
    const workdir = join(tmp, 'workdir');
    mkdirSync(workdir, { recursive: true });
    const calls = [];
    const ev = evaluateOutcomeLivePredicates({
      id: 'outcome-cmd', fixture: 'node-app',
      expected_outcome: { predicates: [
        { id: 'cmd-python', kind: 'commands_pass', evaluate_in: 'live', commands: ['node -v', 'python --version'] },
      ] },
    }, {
      repoRoot: tmp, workdir,
      spawn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0 }; },
    });
    const byId = Object.fromEntries(ev.results.map((r) => [r.id, r]));
    assert.equal(byId['cmd-python'].result, 'unverified');
    assert.match(byId['cmd-python'].detail, /allowlist/);
    assert.deepEqual(calls, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('commands_pass: secrets scrubbed from child env and bounds passed (stub)', () => {
  const tmp = makeTempDir();
  const prev = process.env.AGT_E2E_TOKEN;
  try {
    process.env.AGT_E2E_TOKEN = 'super-secret-123';
    const workdir = join(tmp, 'workdir');
    mkdirSync(workdir, { recursive: true });
    let captured = null;
    const ev = evaluateOutcomeLivePredicates({
      id: 'outcome-cmd', fixture: 'node-app',
      expected_outcome: { predicates: [
        { id: 'cmd-stub', kind: 'commands_pass', evaluate_in: 'live', commands: ['node -v'] },
      ] },
    }, {
      repoRoot: tmp, workdir,
      spawn: (cmd, args, opts) => {
        captured = { cmd, args, opts };
        return { status: 0 };
      },
    });
    const byId = Object.fromEntries(ev.results.map((r) => [r.id, r]));
    assert.equal(byId['cmd-stub'].result, 'passed');
    assert.ok(captured);
    assert.equal(captured.cmd, 'node');
    assert.deepEqual(captured.args, ['-v']);
    assert.equal(captured.opts.env.AGT_E2E_TOKEN, undefined);
    assert.ok(captured.opts.env.PATH, 'PATH preserved');
    assert.equal(captured.opts.timeout > 0, true);
    assert.equal(captured.opts.maxBuffer > 0, true);
  } finally {
    if (prev === undefined) delete process.env.AGT_E2E_TOKEN; else process.env.AGT_E2E_TOKEN = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('commands_pass: real child sees no scrubbed secret and bounds are real', () => {
  const tmp = makeTempDir();
  const prev = process.env.AGT_E2E_TOKEN;
  let prevProbe;
  try {
    process.env.AGT_E2E_TOKEN = 'super-secret-123';
    const workdir = join(tmp, 'workdir');
    mkdirSync(workdir, { recursive: true });
    const hold = join(workdir, 'hold.js'); // workdir-relative: backslash-free, charset-safe on win32
    const spew = join(workdir, 'spew.js');
    writeFileSync(hold, 'const t = Date.now(); while (Date.now() - t < 30000) { /* spin */ } process.exit(0);\n');
    writeFileSync(spew, 'process.stdout.write("x".repeat(4096));\n');
    prevProbe = process.env.AGT_E2E_PROBE;
    process.env.AGT_E2E_PROBE = 'leak-if-visible';
    const ev = evaluateOutcomeLivePredicates({
      id: 'outcome-cmd', fixture: 'node-app',
      expected_outcome: { predicates: [
        { id: 'cmd-tmo', kind: 'commands_pass', evaluate_in: 'live', commands: ['node hold.js'] },
        { id: 'cmd-scrub', kind: 'commands_pass', evaluate_in: 'live', commands: ['node -p process.env.AGT_E2E_TOKEN===undefined'] },
        { id: 'cmd-buf', kind: 'commands_pass', evaluate_in: 'live', commands: ['node spew.js'] },
      ] },
    }, {
      repoRoot: tmp, workdir, spawnTimeoutMs: 400, spawnMaxBufferBytes: 2048,
    });
    const byId = Object.fromEntries(ev.results.map((r) => [r.id, r]));
    assert.equal(byId['cmd-tmo'].result, 'failed');
    assert.match(byId['cmd-tmo'].detail, /ETIMEDOUT/);
    assert.equal(byId['cmd-scrub'].result, 'passed');
    assert.equal(byId['cmd-buf'].result, 'failed');
  } finally {
    if (prev === undefined) delete process.env.AGT_E2E_TOKEN; else process.env.AGT_E2E_TOKEN = prev;
    if (prevProbe === undefined) delete process.env.AGT_E2E_PROBE; else process.env.AGT_E2E_PROBE = prevProbe;
    rmSync(tmp, { recursive: true, force: true });
  }
});
