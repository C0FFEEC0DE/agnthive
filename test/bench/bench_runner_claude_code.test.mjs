// Focused Node tests for scripts/bench_runner_claude_code.mjs — pure logic only.
// Covers the meaningful pure/predicate functions, the result.json schema writer,
// and snapshot/build_patch round-trip on a temp dir. Subprocess boundaries
// (runClaude/runVerification) are exercised via an injectable spawnSync stub
// where relevant; otherwise they are not invoked here.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildPrompt,
  buildAgentLabelMap,
  frontmatterField,
  normalizeSubagentKey,
  canonicalizeSubagentLabel,
  flattenMessageText,
  transcriptCandidateText,
  transcriptCandidateScore,
  extractResultTextFromTranscript,
  extractResultPayload,
  extractResultText,
  extractUsedAgentAliases,
  extractUsedAgentEvidence,
  resolveDispatchMode,
  dispatchContractMarker,
  effectiveUsedAliasesForEnforcement,
  requiredUsedAgentMisses,
  isRetryableProviderError,
  isOllama429,
  parseAffordableMaxTokens,
  adjustedOutputTokenBudget,
  detectVerificationTarget,
  isDocsPath,
  isIgnoredRuntimePath,
  snapshotFiles,
  buildPatch,
  buildResult,
  __setSpawnSync,
  runVerification,
} from '../../scripts/bench_runner_claude_code.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const PLUGIN_AGENTS = join(REPO, 'plugins', 'multi-agent-sdlc-crew', 'agents');

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'bench-runner-'));
}

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

test('buildPrompt includes task prompt + plugin context + footer template', () => {
  const prompt = buildPrompt(baseTask({ verification_required: true }), 'npm run test');
  assert.ok(prompt.includes('Add a hello function'), 'prompt contains task prompt');
  assert.ok(prompt.includes('multi-agent-sdlc-crew Claude Code plugin'));
  assert.ok(prompt.includes('--plugin-dir'));
  assert.ok(prompt.includes('Verification status: <passed|failed|not run|not required>'));
  assert.ok(prompt.includes('Review outcome: <done|pending|not required>'));
  assert.ok(prompt.includes('Remaining risks: <one sentence or "none">'));
  assert.ok(prompt.includes('workflow_category: feature'));
  assert.ok(prompt.includes('If verification is required, run the relevant tests locally (npm run test).'));
});

test('buildPrompt emits required specialist handoff block for required agents', () => {
  const prompt = buildPrompt(baseTask({ required_used_agents: ['m', 'cr'] }), 'verification');
  assert.ok(prompt.includes('Required specialist handoff:'));
  assert.ok(prompt.includes('@m -> @cr'));
  assert.ok(prompt.includes('launch @m first'));
  assert.ok(prompt.includes('Handoff evidence: @m, @cr <what the specialist did>'));
});

test('extractUsedAgentAliases accepts explicit and established handoff evidence', () => {
  const labelMap = {
    a: 'a', architect: 'a', dbg: 'dbg', debugger: 'dbg',
    doc: 'doc', docwriter: 'doc', m: 'm', manager: 'm',
  };
  const resultText = [
    'Handoff evidence: @architect separated the normalization design.',
    '@dbg reproduced the failing divide call.',
    '@doc added the Quickstart section.',
    '@m coordinated the documentation update.',
    'Review outcome: done - design note added per @a handoff.',
  ].join('\n');
  assert.deepEqual(
    extractUsedAgentAliases('', null, { resultText }, labelMap).sort(),
    ['a', 'dbg', 'doc', 'm'],
  );
});

test('extractUsedAgentEvidence separates real dispatch (hook) from prose claims', () => {
  const labelMap = { bug: 'bug', bugbuster: 'bug', t: 't', tester: 't' };
  // No SubagentStart in the debug log — only a prose "Handoff evidence:" claim.
  const debugLogText = '';
  const resultText = 'Handoff evidence: @bug fixed divide-by-zero.\nVerification status: passed';
  const evidence = extractUsedAgentEvidence(debugLogText, null, { resultText }, labelMap);
  // Strict observed source must be empty: no real SubagentStart fired.
  assert.deepEqual(evidence.hook, []);
  // The prose claim is still captured as a diagnostic, not as dispatch proof.
  assert.deepEqual(evidence.claimed.sort(), ['bug']);
  assert.equal(evidence.byAlias.bug.hook, false);
  assert.equal(evidence.byAlias.bug.claimed, true);

  // A real SubagentStart in the debug log populates the hook source only.
  const debugWithHook = 'Hook SubagentStart:bug (scope: fix division)';
  const evidence2 = extractUsedAgentEvidence(debugWithHook, null, { resultText }, labelMap);
  assert.deepEqual(evidence2.hook, ['bug']);
  assert.equal(evidence2.byAlias.bug.hook, true);
  assert.equal(evidence2.byAlias.bug.claimed, true);

  // dispatch_contract selects the benchmark dispatch mode; absent = standard.
  assert.equal(resolveDispatchMode({}), 'standard');
  assert.equal(resolveDispatchMode({ dispatch_contract: { mode: 'observed' } }), 'observed');
  assert.equal(resolveDispatchMode({ dispatch_contract: { mode: 'enforced' } }), 'enforced');
});

test('observed/claimed partition mirrors main() wiring: hook is observed, text claims exclude hook', () => {
  const labelMap = { bug: 'bug', bugbuster: 'bug', t: 't', tester: 't' };
  // Real SubagentStart for @bug; prose also claims @bug and @t (no hook for @t).
  const debugLogText = 'Hook SubagentStart:bug (scope: fix division)';
  const resultText = 'Handoff evidence: @bug fixed it.\n@t verified the regression.';
  const evidence = extractUsedAgentEvidence(debugLogText, null, { resultText }, labelMap);
  // Mirror the derivation in main() (bench_runner_claude_code.mjs ~line 2010-2018).
  const observedAgentAliases = evidence.hook;
  const claimedSet = new Set([...evidence.transcript, ...evidence.claimed]);
  for (const alias of evidence.hook) claimedSet.delete(alias);
  const claimedAgentAliases = Array.from(claimedSet);
  const usedAgentAliases = extractUsedAgentAliases(debugLogText, null, { resultText }, labelMap);
  // Observed = real dispatch only.
  assert.deepEqual(observedAgentAliases, ['bug']);
  // A hook-backed alias must NOT leak into claimed (the union-dup bug).
  assert.ok(!claimedAgentAliases.includes('bug'), 'hook alias leaked into claimed');
  // A prose-only alias is captured as claimed.
  assert.ok(claimedAgentAliases.includes('t'), 'prose-only alias missing from claimed');
  // observed ∪ claimed == used (clean partition, no double-counting).
  assert.deepEqual(
    [...observedAgentAliases, ...claimedAgentAliases].sort(),
    usedAgentAliases.sort(),
  );
});

test('dispatchContractMarker builds the root-only contract line', () => {
  assert.equal(dispatchContractMarker({}), '');
  assert.equal(dispatchContractMarker({ dispatch_contract: { mode: 'bogus', required_agents: ['bug'] } }), '');
  assert.equal(
    dispatchContractMarker({ dispatch_contract: { mode: 'observed', required_agents: ['bug'], root_only: true } }),
    'BENCHMARK_DISPATCH_CONTRACT: root_only; mode=observed; roles=bug',
  );
  // root_only defaults to true when omitted.
  assert.equal(
    dispatchContractMarker({ dispatch_contract: { mode: 'enforced', required_agents: ['t', 'cr'] } }),
    'BENCHMARK_DISPATCH_CONTRACT: root_only; mode=enforced; roles=t,cr',
  );
  // root_only: false omits the flag.
  assert.equal(
    dispatchContractMarker({ dispatch_contract: { mode: 'observed', required_agents: ['bug'], root_only: false } }),
    'BENCHMARK_DISPATCH_CONTRACT: mode=observed; roles=bug',
  );
});

test('buildPrompt injects the dispatch-contract marker into the root prompt only when declared', () => {
  const withContract = buildPrompt(
    baseTask({ dispatch_contract: { mode: 'observed', required_agents: ['bug'], root_only: true } }),
    'node --test',
  );
  assert.ok(withContract.includes('BENCHMARK_DISPATCH_CONTRACT: root_only; mode=observed; roles=bug'), withContract);
  // Absent contract -> no marker line.
  const without = buildPrompt(baseTask({}), 'node --test');
  assert.ok(!without.includes('BENCHMARK_DISPATCH_CONTRACT'), 'unexpected marker in prompt without contract');
});

test('buildPrompt emits dispatch-contract discipline only when a contract is declared', () => {
  const withContract = buildPrompt(
    baseTask({ dispatch_contract: { mode: 'observed', required_agents: ['bug'], root_only: true } }),
    'node --test',
  );
  assert.ok(withContract.includes('Dispatch contract discipline:'), withContract);
  assert.ok(withContract.includes('first substantive action must be launching the required specialist'), withContract);
  assert.ok(withContract.includes('Do not Edit, Write, or MultiEdit any file before that specialist has started'), withContract);
  const without = buildPrompt(baseTask({}), 'node --test');
  assert.ok(!without.includes('Dispatch contract discipline:'), 'discipline note leaked into prompt without contract');
});

test('effectiveUsedAliasesForEnforcement: standard credits union, observed/enforced use hook only', () => {
  const union = ['bug', 't'];
  const hook = ['bug'];
  assert.deepEqual(effectiveUsedAliasesForEnforcement('standard', union, hook), union);
  assert.deepEqual(effectiveUsedAliasesForEnforcement('observed', union, hook), hook);
  assert.deepEqual(effectiveUsedAliasesForEnforcement('enforced', union, hook), hook);
});

test('strict observed mode rejects claimed-only dispatch and accepts a real hook', () => {
  const labelMap = { bug: 'bug', bugbuster: 'bug' };
  const task = { required_used_agents: ['bug'], dispatch_contract: { mode: 'observed', required_agents: ['bug'] } };
  const claimedOnlyText = 'Handoff evidence: @bug fixed it.';
  // No SubagentStart: hook source empty, but prose claims @bug.
  const evidence = extractUsedAgentEvidence('', null, { resultText: claimedOnlyText }, labelMap);
  const union = extractUsedAgentAliases('', null, { resultText: claimedOnlyText }, labelMap);
  const observed = effectiveUsedAliasesForEnforcement('observed', union, evidence.hook);
  assert.deepEqual(observed, []);
  assert.deepEqual(requiredUsedAgentMisses(task, observed, labelMap), ['bug']);
  // A real SubagentStart satisfies the strict contract.
  const evidence2 = extractUsedAgentEvidence('Hook SubagentStart:bug (scope: fix)', null, { resultText: claimedOnlyText }, labelMap);
  const observed2 = effectiveUsedAliasesForEnforcement('observed', ['bug'], evidence2.hook);
  assert.deepEqual(observed2, ['bug']);
  assert.deepEqual(requiredUsedAgentMisses(task, observed2, labelMap), []);
});

test('buildAgentLabelMap reads plugin agents into an alias map', () => {
  const map = buildAgentLabelMap(REPO);
  // alias keys from plugin agents (architect->a, tester->t, code-reviewer->cr ...)
  assert.equal(map.a, 'a');
  assert.equal(map.t, 't');
  assert.equal(map.cr, 'cr');
  assert.equal(map.architect, 'a');
  assert.equal(map.tester, 't');
  assert.equal(map['code-reviewer'], 'cr');
  assert.equal(map.manager, 'm');
  assert.equal(map.docwriter, 'doc');
});

test('buildAgentLabelMap works with a temp agents dir', () => {
  const tmp = makeTempDir();
  try {
    const agentsDir = join(tmp, 'plugins', 'multi-agent-sdlc-crew', 'agents');
    const assetsDir = join(tmp, 'plugins', 'multi-agent-sdlc-crew', 'assets');
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'custom.md'),
      '---\nname: Custom\nalias: c\ndescription: x\ntype: Custom\n---\nbody\n',
    );
    writeFileSync(join(assetsDir, 'aliases.json'), JSON.stringify({ c: ['c', 'custom'] }));
    const map = buildAgentLabelMap(tmp);
    assert.equal(map.c, 'c');
    assert.equal(map.custom, 'c');
    assert.equal(map.Custom, undefined); // normalizeSubagentKey lowercases keys
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('frontmatterField reads alias/name/type from a plugin agent file', () => {
  const architect = join(PLUGIN_AGENTS, 'architect.md');
  assert.equal(frontmatterField(architect, 'alias'), 'a');
  assert.equal(frontmatterField(architect, 'name'), 'Architect');
  assert.ok(['Plan', 'Plan/Architect', 'Architect'].includes(frontmatterField(architect, 'type')));
  assert.equal(frontmatterField(architect, 'nonexistent'), null);
});

test('normalizeSubagentKey strips @, lowercases, collapses separators', () => {
  assert.equal(normalizeSubagentKey('@Code-Reviewer'), 'code-reviewer');
  assert.equal(normalizeSubagentKey('The_Architect'), 'the-architect');
  assert.equal(normalizeSubagentKey('  Big Boss  '), 'big-boss');
  assert.equal(normalizeSubagentKey('bug--pattern'), 'bug-pattern');
  assert.equal(normalizeSubagentKey(''), '');
});

test('canonicalizeSubagentLabel maps variants to aliases', () => {
  const map = { 'code-reviewer': 'cr', cr: 'cr', reviewer: 'cr', a: 'a' };
  assert.equal(canonicalizeSubagentLabel('Code Reviewer', map), 'cr');
  assert.equal(canonicalizeSubagentLabel('@cr', map), 'cr');
  assert.equal(canonicalizeSubagentLabel('reviewer', map), 'cr');
  // Unknown label with no value match returns null.
  assert.equal(canonicalizeSubagentLabel('unknown-role', map), null);
});

test('flattenMessageText joins content blocks', () => {
  assert.equal(flattenMessageText('plain'), 'plain');
  assert.equal(flattenMessageText([{ text: 'a' }, { content: 'b' }, { text: '   ' }]), 'a\nb');
  assert.equal(flattenMessageText([{ text: 'a' }, 'stray', 5, null]), 'a');
  assert.equal(flattenMessageText(123), '');
  assert.equal(flattenMessageText(null), '');
});

test('transcriptCandidateText picks first non-empty candidate', () => {
  assert.equal(transcriptCandidateText({ result: 'final text' }), 'final text');
  assert.equal(transcriptCandidateText({ message: { content: [{ text: 'msg' }] } }), 'msg');
  assert.equal(transcriptCandidateText({ last_assistant_message: 'last' }), 'last');
  assert.equal(transcriptCandidateText({}), '');
});

test('transcriptCandidateScore rewards footer prefixes', () => {
  const high = transcriptCandidateScore('Verification status: passed\nReview outcome: done\nRemaining risks: none');
  const mid = transcriptCandidateScore('some review of the test');
  const zero = transcriptCandidateScore('totally unrelated text');
  assert.ok(high > mid, `${high} > ${mid}`);
  assert.ok(mid > zero, `${mid} > ${zero}`);
  assert.equal(zero, 0);
});

test('extractResultPayload / extractResultText parse claude JSON stdout', () => {
  const payload = extractResultPayload(JSON.stringify({ result: 'done', subtype: 'result' }));
  assert.ok(payload && typeof payload === 'object');
  assert.equal(extractResultText(payload), 'done');
  assert.equal(extractResultPayload(''), null);
  assert.equal(extractResultPayload('not json'), null);
  assert.equal(extractResultPayload('[1,2,3]'), null);
  assert.equal(extractResultText(null), '');
});

test('extractResultTextFromTranscript reads transcript events and scores them', () => {
  const tmp = makeTempDir();
  try {
    const transcript = join(tmp, 'transcript.jsonl');
    const events = [
      { type: 'assistant', message: { role: 'assistant', content: [{ text: 'Working...' }] } },
      { type: 'result', result: 'Verification status: passed - ok\nReview outcome: done - ok\nRemaining risks: none' },
      { type: 'user', message: { role: 'user', content: [{ text: 'please do the task' }] } },
    ];
    writeFileSync(transcript, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const payload = { transcript_path: transcript };
    const text = extractResultTextFromTranscript(payload);
    assert.ok(text.includes('Verification status: passed'));
    assert.ok(text.includes('Remaining risks: none'));
    // Missing transcript returns empty.
    assert.equal(extractResultTextFromTranscript({ transcript_path: join(tmp, 'missing.jsonl') }), '');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('retry predicates: isRetryableProviderError', () => {
  assert.equal(isRetryableProviderError('429 Too Many Requests'), true);
  assert.equal(isRetryableProviderError('Rate limit exceeded'), true);
  assert.equal(isRetryableProviderError('provider returned error: boom'), true);
  assert.equal(isRetryableProviderError('API error: 403 daily limit exceeded'), false);
  assert.equal(isRetryableProviderError('all good here'), false);
});

test('retry predicates: isOllama429', () => {
  assert.equal(isOllama429('HTTP 429'), true);
  assert.equal(isOllama429('rate limit hit'), true);
  assert.equal(isOllama429(''), false);
  assert.equal(isOllama429('normal error'), false);
});

test('retry predicates: parseAffordableMaxTokens + adjustedOutputTokenBudget', () => {
  assert.deepEqual(parseAffordableMaxTokens('requested up to 8000 tokens, but can only afford 4000'), [8000, 4000]);
  assert.equal(parseAffordableMaxTokens('no budget info'), null);
  assert.equal(adjustedOutputTokenBudget(4000), 4000 - Math.min(128, 400)); // 4000-128
  assert.equal(adjustedOutputTokenBudget(0), null);
  assert.equal(adjustedOutputTokenBudget(-5), null);
  // Tiny budget floors at 256.
  assert.equal(adjustedOutputTokenBudget(100), 256);
});

test('detectVerificationTarget returns npm/cargo/go/node --test argv by fixture layout', () => {
  const tmp = makeTempDir();
  try {
    // npm: package.json with test script.
    const nodeApp = join(tmp, 'node');
    mkdirSync(nodeApp);
    writeFileSync(join(nodeApp, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    assert.deepEqual(detectVerificationTarget(nodeApp), [['npm', 'run', 'test', '--silent'], 'npm run test']);
    // package.json without test script -> no target.
    const nodeNoTest = join(tmp, 'nodetest');
    mkdirSync(nodeNoTest);
    writeFileSync(join(nodeNoTest, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    assert.deepEqual(detectVerificationTarget(nodeNoTest), [null, null]);
    // malformed package.json -> [null, null].
    const badJson = join(tmp, 'badjson');
    mkdirSync(badJson);
    writeFileSync(join(badJson, 'package.json'), '{ not json');
    assert.deepEqual(detectVerificationTarget(badJson), [null, null]);
    // cargo.
    const cargo = join(tmp, 'cargo');
    mkdirSync(cargo);
    writeFileSync(join(cargo, 'Cargo.toml'), '[package]\nname = "x"\n');
    assert.deepEqual(detectVerificationTarget(cargo), [['cargo', 'test', '--quiet'], 'cargo test']);
    // go.
    const goDir = join(tmp, 'go');
    mkdirSync(goDir);
    writeFileSync(join(goDir, 'go.mod'), 'module x\n');
    assert.deepEqual(detectVerificationTarget(goDir), [['go', 'test', './...'], 'go test ./...']);
    // node --test: top-level *.test.mjs.
    const nd = join(tmp, 'nd');
    mkdirSync(nd);
    writeFileSync(join(nd, 'calc.test.mjs'), "import {test} from 'node:test'\n");
    const [cmd, label] = detectVerificationTarget(nd);
    assert.deepEqual(cmd, ['node', '--test']);
    assert.equal(label, 'node --test');
    // empty dir -> [null, null].
    const empty = join(tmp, 'empty');
    mkdirSync(empty);
    assert.deepEqual(detectVerificationTarget(empty), [null, null]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('runVerification reports missing target via injected spawnSync (not invoked)', () => {
  // When no target is detected, spawnSync is never called — so no stub needed.
  const tmp = makeTempDir();
  try {
    const [testsRun, testsPassed, output, label] = runVerification(tmp);
    assert.equal(testsRun, false);
    assert.equal(testsPassed, false);
    assert.ok(output.includes('No supported automated verification target'));
    assert.equal(label, 'verification');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('runVerification runs the detected command and reports pass/fail via stub', () => {
  const tmp = makeTempDir();
  try {
    const nodeApp = join(tmp, 'node');
    mkdirSync(nodeApp);
    writeFileSync(join(nodeApp, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    let captured;
    __setSpawnSync((bin, args, opts) => {
      captured = { bin, args, opts };
      return { status: 0, stdout: '1 passed', stderr: '' };
    });
    try {
      const [testsRun, testsPassed, output, label] = runVerification(nodeApp);
      assert.equal(testsRun, true);
      assert.equal(testsPassed, true);
      assert.equal(label, 'npm run test');
      assert.ok(output.includes('1 passed'));
      assert.equal(captured.bin, 'npm');
      assert.deepEqual(captured.args, ['run', 'test', '--silent']);
      assert.equal(captured.opts.cwd, nodeApp);
    } finally {
      __setSpawnSync(null); // restore real spawnSync
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('isDocsPath / isIgnoredRuntimePath', () => {
  assert.equal(isDocsPath('docs/guide.md'), true);
  assert.equal(isDocsPath('README.md'), true);
  assert.equal(isDocsPath('CHANGELOG.md'), true);
  assert.equal(isDocsPath('CLAUDE.md'), true);
  assert.equal(isDocsPath('src/lib.js'), false);
  assert.equal(isDocsPath('guide.txt'), true);
  assert.equal(isIgnoredRuntimePath(join('x', '__pycache__', 'y.pyc')), true);
  assert.equal(isIgnoredRuntimePath(join('x', '.coverage')), true);
  assert.equal(isIgnoredRuntimePath(join('src', 'lib.js')), false);
});

test('snapshotFiles + buildPatch round-trip on a temp dir', () => {
  const tmp = makeTempDir();
  try {
    writeFileSync(join(tmp, 'a.txt'), 'hello\n');
    mkdirSync(join(tmp, 'sub'), { recursive: true });
    writeFileSync(join(tmp, 'sub', 'b.txt'), 'world\n');
    const before = snapshotFiles(tmp);
    // Modify a.txt, add c.txt, leave b.txt unchanged.
    writeFileSync(join(tmp, 'a.txt'), 'hello there\n');
    writeFileSync(join(tmp, 'c.txt'), 'new\n');
    const after = snapshotFiles(tmp);
    const patch = buildPatch(before, after);
    assert.ok(patch.includes('--- a/a.txt'));
    assert.ok(patch.includes('+++ b/a.txt'));
    assert.ok(patch.includes('-hello\n'));
    assert.ok(patch.includes('+hello there\n'));
    assert.ok(patch.includes('--- a/c.txt'));
    assert.ok(patch.includes('+++ b/c.txt'));
    assert.ok(patch.includes('+new\n'));
    // b.txt unchanged -> not in patch.
    assert.ok(!patch.includes('b.txt'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPatch marks binary diffs and skips text diff', () => {
  const tmp = makeTempDir();
  try {
    writeFileSync(join(tmp, 'bin.dat'), Buffer.from([0x00, 0x01, 0xff]));
    const before = snapshotFiles(tmp);
    writeFileSync(join(tmp, 'bin.dat'), Buffer.from([0x00, 0x02, 0xff]));
    const after = snapshotFiles(tmp);
    const patch = buildPatch(before, after);
    assert.ok(patch.includes('Binary files differ: bin.dat'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildResult replicates the full result.json schema with correct types', () => {
  const result = buildResult({
    taskId: 't1',
    taskPath: 'bench/tasks/t1.json',
    status: 'passed',
    completed: true,
    verificationRequired: true,
    testsRun: true,
    testsPassed: true,
    reviewRequired: false,
    reviewPresent: false,
    docsRequired: false,
    docsUpdated: false,
    runtimeSeconds: 12.345,
    notes: 'Claude model=x.',
    category: 'feature',
    changedFiles: ['src/a.js'],
    nonDocChangedFiles: ['src/a.js'],
    verificationSummaryPresent: true,
    risksPresent: true,
    exitCode: 0,
    payloadSubtype: 'result',
    payloadStopReason: 'end_turn',
    payloadHardStop: false,
    timeoutRecovered: false,
    maxTurnsRecovered: false,
    recoveredNonzeroExit: false,
    summaryRepairedBy: 'none',
    summaryRepairAttempts: 0,
    permissionDenialsCount: 0,
    firstPermissionDenial: 'none',
    docPatternHits: [],
    transcriptScanned: true,
    transcriptPatternHits: [],
    requiredTranscriptScanned: true,
    requiredTranscriptMisses: [],
    usedAgentAliases: ['e'],
    missingRequiredUsedAgents: [],
    missingRequiredUsedAgentGroups: [],
    fatalError: '',
    failures: [],
  });

  // Required fields consumed by run-benchmark.mjs validateResult.
  assert.equal(result.task_id, 't1');
  assert.ok(result.status);
  assert.ok(result.notes);
  for (const f of [
    'completed', 'verification_required', 'tests_run', 'tests_passed',
    'review_required', 'review_present', 'docs_required', 'docs_updated',
    'policy_violations', 'tool_failures', 'runtime_seconds',
  ]) {
    assert.ok(f in result, `missing required field ${f}`);
  }
  // Full schema field set (matches Python result dict).
  const expectedKeys = [
    'task_id', 'task_path', 'status', 'completed', 'verification_required',
    'tests_run', 'tests_passed', 'review_required', 'review_present',
    'docs_required', 'docs_updated', 'policy_violations', 'tool_failures',
    'runtime_seconds', 'notes', 'category', 'changed_files',
    'non_doc_changed_files', 'verification_summary_present',
    'risk_summary_present', 'claude_exit_code', 'claude_subtype',
    'claude_stop_reason', 'claude_hard_stop', 'timeout_recovered',
    'max_turns_recovered', 'recovered_nonzero_exit', 'summary_repaired_by',
    'summary_repair_attempts', 'permission_denials_count',
    'first_permission_denial', 'forbidden_doc_pattern_hits',
    'transcript_scanned', 'forbidden_transcript_pattern_hits',
    'required_transcript_scanned', 'required_transcript_pattern_misses',
    'used_agent_aliases', 'observed_agent_aliases', 'claimed_agent_aliases',
    'agent_evidence_by_alias', 'dispatch_mode', 'missing_required_used_agents',
    'missing_required_used_agent_groups', 'fatal_error', 'failures',
  ];
  assert.deepEqual(Object.keys(result).sort(), [...expectedKeys].sort());
  // Type checks on key fields.
  assert.equal(typeof result.runtime_seconds, 'number');
  assert.equal(typeof result.notes, 'string');
  assert.ok(Array.isArray(result.changed_files));
  assert.ok(Array.isArray(result.failures));
  assert.equal(result.policy_violations, 0);
  assert.equal(result.tool_failures, 0); // passed -> 0
  // failed status -> tool_failures 1.
  const failed = buildResult({ ...result, status: 'failed', taskId: 't2' });
  assert.equal(failed.tool_failures, 1);
});

test('main writes result.json + summary files for a stub env (no real claude)', async () => {
  // Drive main() end-to-end with a stubbed spawnSync so no real `claude` is needed.
  const tmp = makeTempDir();
  try {
    const workdir = join(tmp, 'workdir');
    const outputDir = join(tmp, 'output');
    const taskFile = join(tmp, 'task.json');
    mkdirSync(workdir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(workdir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    writeFileSync(taskFile, JSON.stringify(baseTask({ verification_required: true, id: 'stub-task' })));

    // Stub claude to emit a result JSON with a complete footer.
    const fakeResultText =
      'Did the work.\n\nVerification status: passed - npm run test completed successfully.\n' +
      'Review outcome: not required - benchmark task did not require an explicit review summary.\n' +
      'Remaining risks: none';
    const fakeStdout = JSON.stringify({ result: fakeResultText, subtype: 'result', stop_reason: 'end_turn' });
    const spawnCalls = [];
    const stub = (bin, args, opts) => {
      spawnCalls.push({ bin, args: [...args], opts });
      // The npm test verification command also flows through here; report pass.
      if (bin === 'npm') return { status: 0, stdout: '1 passed', stderr: '' };
      // Everything else is `claude`: simulate an edit so the run is "completed".
      writeFileSync(join(workdir, 'src.js'), 'export const hello = () => "hello";\n');
      return { status: 0, stdout: fakeStdout, stderr: '' };
    };
    const env = {
      ...process.env,
      BENCH_REPO_ROOT: REPO,
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
      // Re-import a fresh copy of main with env set, since constants are read
      // at module evaluation. Use a cache-busting query so Node re-evaluates it.
      const mod = await import(`../../scripts/bench_runner_claude_code.mjs?env=${Date.now()}`);
      // The stub must be set on the SAME module instance that main() runs in.
      mod.__setSpawnSync(stub);
      const rc = mod.main();
      assert.equal(rc, 0);
      // result.json written and validates.
      const resultPath = join(outputDir, 'result.json');
      assert.ok(existsSync(resultPath), 'result.json written');
      const result = JSON.parse(readFileSync(resultPath, 'utf-8'));
      assert.equal(result.task_id, 'stub-task');
      assert.equal(result.status, 'passed');
      assert.equal(result.claude_exit_code, 0);
      assert.ok(existsSync(join(outputDir, 'claude-result.json')));
      assert.ok(existsSync(join(outputDir, 'task-summary.txt')));
      assert.ok(existsSync(join(outputDir, 'changed-files.json')));
      assert.ok(spawnCalls.some((c) => c.bin === 'claude' && c.args.includes('--plugin-dir')));
      assert.ok(spawnCalls.some((c) => c.bin === 'claude' && c.args.includes('--output-format') && c.args[c.args.indexOf('--output-format') + 1] === 'json'));
      assert.ok(spawnCalls.some((c) => c.bin === 'npm'), 'verification npm spawned');
    } finally {
      process.env = oldEnv;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
