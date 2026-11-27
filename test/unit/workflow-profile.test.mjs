// Tests for the workflow_profile selector (plan task 11; ADR 0008/0009/0012):
// config resolution precedence + validation, and the classification routing.
//
// Plan task 16 removed the `legacy` profile after the compatibility window:
// the root-orchestration shape is the only shape. The selector survives only so
// an old userConfig does not break, and it resolves the removed profile with an
// EXPLICIT migration note (never a silent switch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveWorkflowProfile, reportWorkflowProfileNote,
  WORKFLOW_PROFILES, DEFAULT_WORKFLOW_PROFILE, REMOVED_WORKFLOW_PROFILE,
} from '../../plugins/agnthive/modules/plugin-config.mjs';
import { classifyPrompt } from '../../plugins/agnthive/modules/workflow.mjs';

test('resolveWorkflowProfile: default is lean with no note', () => {
  assert.equal(DEFAULT_WORKFLOW_PROFILE, 'lean');
  assert.deepEqual([...WORKFLOW_PROFILES], ['lean'], 'plan task 16 removed the legacy profile');
  const r = resolveWorkflowProfile({});
  const exp = { profile: 'lean', source: 'default', raw: '', valid: true, note: '' };
  assert.deepEqual(r, exp);
});

test('resolveWorkflowProfile: precedence env > userConfig bridge > default', () => {
  const envOnly = resolveWorkflowProfile({ AGNTHIVE_WORKFLOW_PROFILE: 'lean' });
  assert.equal(envOnly.profile, 'lean');
  assert.equal(envOnly.source, 'env');
  const ucOnly = resolveWorkflowProfile({ CLAUDE_PLUGIN_OPTION_WORKFLOW_PROFILE: 'lean' });
  assert.equal(ucOnly.profile, 'lean');
  assert.equal(ucOnly.source, 'userConfig:workflow_profile');
  const both = resolveWorkflowProfile({ AGNTHIVE_WORKFLOW_PROFILE: 'legacy', CLAUDE_PLUGIN_OPTION_WORKFLOW_PROFILE: 'lean' });
  assert.equal(both.profile, 'lean', 'the removed profile resolves to the only profile');
  assert.equal(both.source, 'env', 'the env override still decides the source');
  const blank = resolveWorkflowProfile({ AGNTHIVE_WORKFLOW_PROFILE: '   ' });
  assert.equal(blank.profile, 'lean', 'a blank override falls through to the default');
  assert.equal(blank.source, 'default');
  const skip = resolveWorkflowProfile({ AGNTHIVE_WORKFLOW_PROFILE: '   ', CLAUDE_PLUGIN_OPTION_WORKFLOW_PROFILE: 'lean' });
  assert.equal(skip.profile, 'lean', 'blank env override falls through to the bridge');
});

test('resolveWorkflowProfile: the removed legacy profile is an explicit migration', () => {
  const r = resolveWorkflowProfile({ AGNTHIVE_WORKFLOW_PROFILE: 'legacy' });
  assert.equal(r.profile, 'lean', 'the removed profile runs the only profile');
  assert.equal(r.valid, false, 'the value is not a valid profile any more');
  assert.ok(r.note.includes('AGNTHIVE_WORKFLOW_PROFILE'), 'note names the source key');
  assert.ok(r.note.includes('legacy'), 'note names the removed profile');
  assert.ok(r.note.includes('REMOVED'), 'note states that the profile was removed');
  assert.equal(REMOVED_WORKFLOW_PROFILE, 'legacy');
});

test('resolveWorkflowProfile: an invalid override runs the only profile with a note', () => {
  const r = resolveWorkflowProfile({ AGNTHIVE_WORKFLOW_PROFILE: 'turbo' });
  assert.equal(r.profile, 'lean');
  assert.equal(r.valid, false);
  assert.ok(r.note.includes('AGNTHIVE_WORKFLOW_PROFILE'), 'note names the source key');
  assert.ok(r.note.includes('turbo'), 'note names the bad value');
  const uc = resolveWorkflowProfile({ CLAUDE_PLUGIN_OPTION_WORKFLOW_PROFILE: 'LEAN ' });
  assert.equal(uc.profile, 'lean', 'value is case-insensitive/trimmed');
  assert.equal(uc.valid, true);
  const ucBad = resolveWorkflowProfile({ CLAUDE_PLUGIN_OPTION_WORKFLOW_PROFILE: 'faster' });
  assert.equal(ucBad.profile, 'lean');
  assert.equal(ucBad.valid, false);
  assert.ok(ucBad.note.includes('CLAUDE_PLUGIN_OPTION_WORKFLOW_PROFILE'), 'note names the bridge key');
});

test('reportWorkflowProfileNote writes only when a note is present', () => {
  const bad = resolveWorkflowProfile({ AGNTHIVE_WORKFLOW_PROFILE: 'turbo' });
  const seen = [];
  assert.equal(reportWorkflowProfileNote(bad, (l) => seen.push(l)), true);
  assert.ok(seen[0].includes('plugin-config:'));
  const good = resolveWorkflowProfile({});
  const seen2 = [];
  assert.equal(reportWorkflowProfileNote(good, (l) => seen2.push(l)), false);
  assert.equal(seen2.length, 0);
});

test('classifyPrompt: the categories keep @cr only (no role quotas)', () => {
  const feature = classifyPrompt('implement the new api feature');
  assert.equal(feature.taskType, 'feature');
  assert.deepEqual(feature.requiredSubagents, ['cr']);
  assert.deepEqual(feature.requiredSubagentAnyOf, []);
  assert.equal(feature.docsRequired, true, 'docs stays a decision flag');
  const docs = classifyPrompt('update the readme to doc the change');
  assert.deepEqual(docs.requiredSubagents, [], 'no docs-persona quota');
  assert.equal(docs.docsRequired, true);
  const review = classifyPrompt('review the auth changes');
  assert.deepEqual(review.requiredSubagents, ['cr'], 'review keeps @cr');
  assert.equal(review.profile, 'lean', 'the recorded profile is the only profile');
});

test('classifyPrompt: plan-only still clears roles and keeps the plan message', () => {
  const r = classifyPrompt('plan only, do not implement the feature');
  assert.equal(r.managerMode, 'plan_only');
  assert.deepEqual(r.requiredSubagents, []);
  assert.ok(r.contextMessage.includes('Plan-only'), 'plan-only wording stays');
  assert.ok(!r.contextMessage.includes('root-orchestration profile'), 'plan-only keeps the plan message');
});

test('classifyPrompt: the dispatch contract is bench-scoped (F03)', () => {
  const marker = 'BENCHMARK_DISPATCH_CONTRACT: root_only; mode=enforced; roles=cr implement the login feature';
  const bench = classifyPrompt(marker + ' do the thing', { benchContext: true });
  assert.deepEqual(bench.requiredSubagents, ['cr'], 'contract honored in its test mode');
  assert.equal(bench.dispatchContractMode, 'enforced');
  assert.equal(bench.dispatchContractClaimOnly, false);
  const nonBench = classifyPrompt(marker + ' do the thing');
  assert.deepEqual(nonBench.requiredSubagents, ['cr'], 'category @cr survives the scoped-out marker');
  assert.equal(nonBench.dispatchContractMode, '');
  assert.equal(nonBench.dispatchContractClaimOnly, true);
  assert.ok(nonBench.contextMessage.includes('ignored'));
});
