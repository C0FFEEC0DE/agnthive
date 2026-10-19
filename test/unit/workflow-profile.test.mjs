// Tests for the workflow_profile selector (plan task 11; ADR 0008/0009/0012):
// config resolution precedence + validation, lean classification routing, and
// the leanProfileGates contract the orchestrator consumes at the
// summary-contract/verify gate call sites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveWorkflowProfile, reportWorkflowProfileNote,
  WORKFLOW_PROFILES, DEFAULT_WORKFLOW_PROFILE,
} from '../../plugins/agnthive/modules/plugin-config.mjs';
import {
  classifyPrompt, leanProfileGates, leanRequiredRoles,
} from '../../plugins/agnthive/modules/workflow.mjs';

const LEGACY_FLAGS = {
  profile: 'legacy', lean: false, benchContractOnly: false,
  enforceRoleQuotas: true, enforceManagerIdleGate: true,
  enforceReviewGate: true, enforceVerificationGate: true, enforceFooterGates: true,
};
const LEAN_FLAGS = {
  profile: 'lean', lean: true, benchContractOnly: true,
  enforceRoleQuotas: false, enforceManagerIdleGate: false,
  enforceReviewGate: true, enforceVerificationGate: true, enforceFooterGates: false,
};

test('resolveWorkflowProfile: default is legacy with no note', () => {
  assert.equal(DEFAULT_WORKFLOW_PROFILE, 'legacy');
  assert.deepEqual([...WORKFLOW_PROFILES], ['legacy', 'lean']);
  const r = resolveWorkflowProfile({});
  const exp = { profile: 'legacy', source: 'default', raw: '', valid: true, note: '' };
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
  assert.equal(both.profile, 'legacy', 'env override beats the userConfig bridge');
  const blank = resolveWorkflowProfile({ AGNTHIVE_WORKFLOW_PROFILE: '   ' });
  assert.equal(blank.profile, 'legacy');
  const skip = resolveWorkflowProfile({ AGNTHIVE_WORKFLOW_PROFILE: '   ', CLAUDE_PLUGIN_OPTION_WORKFLOW_PROFILE: 'lean' });
  assert.equal(skip.profile, 'lean', 'blank env override falls through to the bridge');
});

test('resolveWorkflowProfile: invalid override falls back to legacy with a note', () => {
  const r = resolveWorkflowProfile({ AGNTHIVE_WORKFLOW_PROFILE: 'turbo' });
  assert.equal(r.profile, 'legacy');
  assert.equal(r.valid, false);
  assert.ok(r.note.includes('AGNTHIVE_WORKFLOW_PROFILE'), 'note names the source key');
  assert.ok(r.note.includes('turbo'), 'note names the bad value');
  const uc = resolveWorkflowProfile({ CLAUDE_PLUGIN_OPTION_WORKFLOW_PROFILE: 'LEAN ' });
  assert.equal(uc.profile, 'lean', 'value is case-insensitive/trimmed');
  const ucBad = resolveWorkflowProfile({ CLAUDE_PLUGIN_OPTION_WORKFLOW_PROFILE: 'faster' });
  assert.equal(ucBad.profile, 'legacy');
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

test('leanProfileGates: legacy state keeps every gate on', () => {
  assert.deepEqual(leanProfileGates(null), LEGACY_FLAGS);
  assert.deepEqual(leanProfileGates({}), LEGACY_FLAGS);
  assert.deepEqual(leanProfileGates({ workflow_profile: 'legacy' }), LEGACY_FLAGS);
  const inv = leanProfileGates({ workflow_profile: 'turbo' });
  assert.equal(inv.lean, false, 'invalid state value falls back to legacy');
  assert.equal(inv.enforceRoleQuotas, true);
});

test('leanProfileGates: lean state flips only the relaxing flags', () => {
  const flags = leanProfileGates({ workflow_profile: 'lean' });
  assert.deepEqual(flags, LEAN_FLAGS);
  assert.equal(flags.enforceRoleQuotas, false);
  assert.equal(flags.enforceManagerIdleGate, false);
  assert.equal(flags.enforceFooterGates, false);
  assert.equal(flags.enforceReviewGate, true, '@cr gate kept');
  assert.equal(flags.enforceVerificationGate, true, 'verification-evidence gates kept');
  assert.equal(flags.benchContractOnly, true, 'dispatch contract scoped to tests');
});

test('leanProfileGates: explicit profile arg overrides state and is validated', () => {
  assert.equal(leanProfileGates({ workflow_profile: 'lean' }, 'legacy').lean, false,
    'the orchestrator-passed profile beats a state pin');
  assert.equal(leanProfileGates({ workflow_profile: 'legacy' }, 'lean').lean, true);
  assert.equal(leanProfileGates({}, 'LEAN').lean, true, 'wiring-side value is trimmed/lowercased');
  assert.equal(leanProfileGates({}, 'turbo').lean, false, 'invalid wiring value falls back to legacy');
  assert.deepEqual(leanProfileGates(null, 'lean'), LEAN_FLAGS);
});

test('classifyPrompt: lean routes categories without quotas and keeps @cr', () => {
  const leanFeature = classifyPrompt('implement the new api feature', { profile: 'lean' });
  assert.equal(leanFeature.taskType, 'feature');
  assert.deepEqual(leanFeature.requiredSubagents, ['cr']);
  assert.deepEqual(leanFeature.requiredSubagentAnyOf, []);
  assert.equal(leanFeature.docsRequired, true, 'docs stays a decision flag');
  const leanDocs = classifyPrompt('update the readme to doc the change', { profile: 'lean' });
  assert.deepEqual(leanDocs.requiredSubagents, [], '@doc quota dropped for docs work');
  assert.equal(leanDocs.docsRequired, true);
  const leanReview = classifyPrompt('review the auth changes', { profile: 'lean' });
  assert.deepEqual(leanReview.requiredSubagents, ['cr'], 'review keeps @cr');
});

test('classifyPrompt: lean plan-only still clears roles and keeps the plan message', () => {
  const r = classifyPrompt('plan only, do not implement the feature', { profile: 'lean' });
  assert.equal(r.managerMode, 'plan_only');
  assert.deepEqual(r.requiredSubagents, []);
  assert.ok(r.contextMessage.includes('Plan-only'), 'plan-only wording stays');
  assert.ok(!r.contextMessage.includes('Lean profile'), 'plan-only keeps the plan message');
});

test('classifyPrompt: lean bench-scopes the dispatch contract (F03)', () => {
  const marker = 'BENCHMARK_DISPATCH_CONTRACT: root_only; mode=enforced; roles=t,cr implement the login feature';
  const bench = classifyPrompt(marker + ' do the thing', { profile: 'lean', benchContext: true });
  assert.deepEqual(bench.requiredSubagents, ['t', 'cr'], 'contract honored in its test mode');
  assert.equal(bench.dispatchContractMode, 'enforced');
  assert.equal(bench.dispatchContractClaimOnly, false);
  const nonBench = classifyPrompt(marker + ' do the thing', { profile: 'lean' });
  assert.deepEqual(nonBench.requiredSubagents, ['cr'], 'category @cr survives the scoped-out marker');
  assert.equal(nonBench.dispatchContractMode, '');
  assert.equal(nonBench.dispatchContractClaimOnly, true);
  assert.ok(nonBench.contextMessage.includes('ignored'));
});

test('classifyPrompt: legacy applies the dispatch contract regardless of bench flag', () => {
  const marker = 'BENCHMARK_DISPATCH_CONTRACT: root_only; mode=observed; roles=cr';
  const r = classifyPrompt(marker + ' review it', { profile: 'legacy', benchContext: false });
  assert.deepEqual(r.requiredSubagents, ['cr']);
  assert.equal(r.dispatchContractMode, 'observed');
  assert.equal(r.dispatchContractClaimOnly, false);
});

test('leanRequiredRoles projects state to the lean-enforced requirement', () => {
  const feat = leanRequiredRoles({ required_subagents: ['t', 'cr'], required_subagent_any_of: [['e', 'a']], docs_required: true });
  assert.deepEqual(feat, { required: ['cr'], anyOf: [], docsRequired: true });
  assert.deepEqual(leanRequiredRoles({ required_subagents: ['doc'], docs_required: true }),
    { required: [], anyOf: [], docsRequired: true });
  assert.deepEqual(leanRequiredRoles({ required_subagents: ['cr'] }),
    { required: ['cr'], anyOf: [], docsRequired: false });
  assert.deepEqual(leanRequiredRoles({}), { required: [], anyOf: [], docsRequired: false });
});

test('leanProfileGates: non-object states and weird inputs fall back to legacy', () => {
  assert.deepEqual(leanProfileGates('x'), LEGACY_FLAGS);
  assert.deepEqual(leanProfileGates([['lean']]), LEGACY_FLAGS);
});
