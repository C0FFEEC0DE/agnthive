// summary-contract.test.mjs — direct unit coverage for the footer-recognition and
// session-decision functions in plugins/agnthive/modules/summary-contract.mjs.
//
// These tests port the behavioral coverage that previously lived in the legacy
// bash-sourcing pytest files (test/validators/test_message_mentions.py,
// test_concrete_outcome_recognition.py, test_hook_effective_roles.py,
// test_high_bugs.py). The legacy files sourced claudecfg/hooks/lib.sh and ran
// bash subprocesses, which made them POSIX-only (CRLF/cp1252 broke them on
// Windows). The plugin Node runtime is the platform-independent replacement,
// so the coverage now lives here as pure Node unit tests that run on every OS.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  messageHasLinePrefix,
  messageHasAnyLinePrefix,
  messageMentionsVerificationStatus,
  messageMentionsReviewOutcome,
  messageMentionsDocsStatus,
  messageMentionsChangedFiles,
  messageMentionsRemainingRisks,
  messageMentionsNextStep,
  messageMentionsConcreteOutcome,
  messageReportsNoChanges,
  sessionAgentEnforcementReason,
  stopSafeNoChangeFooterHint,
  emitLoopAwareBlock,
} from '../../plugins/agnthive/modules/summary-contract.mjs';

// A representative prefix list mirroring the legacy helper test.
const PREFIXES = ['Outcome:', 'Result:', 'Status:'];

// --- message_has_any_line_prefix (helper) ---------------------------------

describe('messageHasAnyLinePrefix', () => {
  it('matches the first prefix', () => {
    assert.equal(messageHasAnyLinePrefix('Outcome: done', ...PREFIXES), true);
  });
  it('matches a later prefix', () => {
    assert.equal(messageHasAnyLinePrefix('Result: ok', ...PREFIXES), true);
  });
  it('returns false when no prefix matches', () => {
    assert.equal(messageHasAnyLinePrefix('nothing here', ...PREFIXES), false);
  });
  it('matches case-insensitively', () => {
    assert.equal(messageHasAnyLinePrefix('outcome: done', ...PREFIXES), true);
  });
  it('trims leading whitespace before matching', () => {
    assert.equal(messageHasAnyLinePrefix('   Outcome: done', ...PREFIXES), true);
  });
  it('matches on a non-first line', () => {
    assert.equal(messageHasAnyLinePrefix('intro line\nOutcome: done\ntrailer', ...PREFIXES), true);
  });
  it('returns false for an empty message', () => {
    assert.equal(messageHasAnyLinePrefix('', ...PREFIXES), false);
  });
  it('returns false for non-string inputs', () => {
    assert.equal(messageHasAnyLinePrefix(null, 'Outcome:'), false);
    assert.equal(messageHasAnyLinePrefix('Outcome: x', null), false);
  });
});

describe('messageHasLinePrefix', () => {
  it('matches a single prefix', () => {
    assert.equal(messageHasLinePrefix('Verification status: passed', 'Verification status:'), true);
  });
  it('returns false when the prefix is absent', () => {
    assert.equal(messageHasLinePrefix('all good here', 'Verification status:'), false);
  });
});

// --- message_mentions_* family --------------------------------------------

describe('messageMentionsVerificationStatus', () => {
  it('recognizes the canonical prefix', () => {
    assert.equal(messageMentionsVerificationStatus('Verification status: passed'), true);
  });
  it('recognizes the short prefix', () => {
    assert.equal(messageMentionsVerificationStatus('Verification: ok'), true);
  });
  it('recognizes the Tests: variant', () => {
    assert.equal(messageMentionsVerificationStatus('Tests: 5 passed'), true);
  });
  it('does not match plain text', () => {
    assert.equal(messageMentionsVerificationStatus('all good here'), false);
  });
});

describe('messageMentionsReviewOutcome', () => {
  it('recognizes the canonical prefix', () => {
    assert.equal(messageMentionsReviewOutcome('Review outcome: approved'), true);
  });
  it('recognizes the short prefix', () => {
    assert.equal(messageMentionsReviewOutcome('Review: clean'), true);
  });
  it('does not match plain text', () => {
    assert.equal(messageMentionsReviewOutcome('looked at the code'), false);
  });
});

describe('messageMentionsDocsStatus', () => {
  it('recognizes the canonical prefix', () => {
    assert.equal(messageMentionsDocsStatus('Docs status: updated'), true);
  });
  it('recognizes the Russian documentation prefix', () => {
    assert.equal(messageMentionsDocsStatus('Документация: обновлена'), true);
  });
  it('does not match plain text', () => {
    assert.equal(messageMentionsDocsStatus('wrote some notes'), false);
  });
});

describe('messageMentionsChangedFiles', () => {
  it('recognizes the canonical prefix', () => {
    assert.equal(messageMentionsChangedFiles('Changed files: a.py, b.py'), true);
  });
  it('recognizes the no-files-changed prefix', () => {
    assert.equal(messageMentionsChangedFiles('No files changed: noop'), true);
  });
  it('does not match plain text', () => {
    assert.equal(messageMentionsChangedFiles('touched nothing'), false);
  });
});

describe('messageMentionsRemainingRisks', () => {
  it('recognizes the canonical prefix', () => {
    assert.equal(messageMentionsRemainingRisks('Remaining risks: none'), true);
  });
  it('recognizes the short prefix', () => {
    assert.equal(messageMentionsRemainingRisks('Risks: low'), true);
  });
  it('does not match plain text', () => {
    assert.equal(messageMentionsRemainingRisks('all safe'), false);
  });
});

describe('messageMentionsNextStep', () => {
  it('recognizes the canonical prefix', () => {
    assert.equal(messageMentionsNextStep('Next step: run tests'), true);
  });
  it('recognizes the plural prefix', () => {
    assert.equal(messageMentionsNextStep('Next steps: a, b'), true);
  });
  it('recognizes the Russian prefix', () => {
    assert.equal(messageMentionsNextStep('Следующий шаг: тесты'), true);
  });
  it('does not match plain text', () => {
    assert.equal(messageMentionsNextStep('nothing pending'), false);
  });
});

// --- message_mentions_concrete_outcome ------------------------------------

describe('messageMentionsConcreteOutcome', () => {
  it('recognizes the Outcome: prefix', () => {
    assert.equal(messageMentionsConcreteOutcome('Outcome: implemented the parser.'), true);
  });
  it('recognizes the Status: prefix (isolated from the keyword fallback)', () => {
    // 'ready' is NOT a loose keyword, so this only passes via the Status: prefix.
    assert.equal(messageMentionsConcreteOutcome('Status: ready'), true);
  });
  it('does not recognize Status without a colon', () => {
    // Proves recognition is the line-prefix 'Status:', not the bare word.
    assert.equal(messageMentionsConcreteOutcome('Status ready'), false);
  });
  it('returns false with no prefix and no keyword', () => {
    assert.equal(messageMentionsConcreteOutcome('hello world, nothing concrete here'), false);
  });
  it('falls back to loose English keywords', () => {
    assert.equal(messageMentionsConcreteOutcome('I investigated the failure and reported it.'), true);
  });
  it('falls back to loose Russian keywords', () => {
    assert.equal(messageMentionsConcreteOutcome('я исправил баг'), true);
  });
});

// --- message_reports_no_changes -------------------------------------------

describe('messageReportsNoChanges', () => {
  it('recognizes "No files changed."', () => {
    assert.equal(messageReportsNoChanges('No files changed.'), true);
  });
  it('recognizes "No changes were made."', () => {
    assert.equal(messageReportsNoChanges('No changes were made.'), true);
  });
  it('recognizes "Nothing changed."', () => {
    assert.equal(messageReportsNoChanges('Nothing changed.'), true);
  });
  it('does not match when changes are reported', () => {
    assert.equal(messageReportsNoChanges('Changed files: a.py'), false);
  });
});

// --- session_agent_enforcement_reason -------------------------------------

describe('sessionAgentEnforcementReason', () => {
  it('blocks when required roles are missing', () => {
    const state = { task_type: 'feature', required_subagents: ['cr'], required_subagent_any_of: [['e', 'a']] };
    const reason = sessionAgentEnforcementReason(state, []);
    assert.ok(reason, 'expected a block reason');
    assert.match(reason, /Missing required roles: @cr/);
    assert.match(reason, /Used so far: none/);
  });

  it('allows when all required roles and one-of groups are satisfied', () => {
    const state = { task_type: 'feature', required_subagents: ['cr'], required_subagent_any_of: [['e', 'dbg']] };
    assert.equal(sessionAgentEnforcementReason(state, ['cr', 'e']), null);
  });

  it('blocks when a one-of group is unsatisfied', () => {
    const state = { task_type: 'feature', required_subagents: ['cr'], required_subagent_any_of: [['e', 'dbg']] };
    const reason = sessionAgentEnforcementReason(state, ['cr']);
    assert.ok(reason);
    assert.match(reason, /Missing one-of groups: @e\/@dbg/);
  });

  it('plan task 16: a recorded legacy role is migrated away, never demanded', () => {
    // The removed agents (a/bug/t/doc/m) cannot be dispatched any more, so a
    // state recorded under the legacy profile must not block on them.
    const state = { task_type: 'feature', required_subagents: ['t', 'cr'], required_subagent_any_of: [['e', 'a']] };
    const reason = sessionAgentEnforcementReason(state, ['cr', 'e']);
    assert.equal(reason, null, 'the legacy @t quota and the @a half of the group are dropped');
    const legacyOnly = { task_type: 'feature', required_subagents: ['t'] };
    assert.equal(sessionAgentEnforcementReason(legacyOnly, []), null, 'a state that only requires a removed role never blocks');
  });

  it('blocks a review task without @cr', () => {
    const state = { task_type: 'review', required_subagents: ['cr'] };
    const reason = sessionAgentEnforcementReason(state, []);
    assert.ok(reason);
    assert.match(reason, /Missing required roles: @cr/);
  });

  it('allows a review task with @cr', () => {
    const state = { task_type: 'review', required_subagents: ['cr'] };
    assert.equal(sessionAgentEnforcementReason(state, ['cr']), null);
  });

  it('allows a bugfix task when @e satisfies the one-of group', () => {
    const state = { task_type: 'bugfix', required_subagents: ['cr'], required_subagent_any_of: [['bug', 'e', 'dbg']] };
    assert.equal(sessionAgentEnforcementReason(state, ['cr', 'e']), null);
  });

  it('returns null when nothing is required', () => {
    assert.equal(sessionAgentEnforcementReason({ task_type: 'other' }, []), null);
  });

  it('never blocks on a removed @t role, verified or not', () => {
    // No test run stands in for @t any more: the role is dropped before the
    // gate looks at started roles, so neither branch can block.
    assert.equal(sessionAgentEnforcementReason({ task_type: 'feature', required_subagents: ['t'] }, []), null);
    assert.equal(sessionAgentEnforcementReason({ task_type: 'feature', required_subagents: ['t'], tests_ok: true }, []), null);
  });

  it('notes manager-led orchestration in the reason', () => {
    const state = { task_type: 'feature', manager_mode: 'orchestrate', required_subagents: ['cr'] };
    const reason = sessionAgentEnforcementReason(state, []);
    assert.match(reason, /Manager-led orchestration is active/);
  });

  it('falls back to state.subagents_started when startedRoles is omitted', () => {
    const state = { task_type: 'feature', required_subagents: ['cr'], subagents_started: ['cr'] };
    assert.equal(sessionAgentEnforcementReason(state), null);
  });
});

// --- stop_safe_no_change_footer_hint --------------------------------------

describe('stopSafeNoChangeFooterHint', () => {
  it('mentions docs status when docs are required', () => {
    const hint = stopSafeNoChangeFooterHint(true);
    assert.ok(hint);
    assert.match(hint, /docs status/);
  });

  it('omits docs status when docs are not required', () => {
    const hint = stopSafeNoChangeFooterHint(false);
    assert.ok(hint);
    assert.doesNotMatch(hint, /docs status/);
    assert.match(hint, /remaining risks/);
  });

  it('always reminds the agent to report actual results after changes', () => {
    for (const docs of [true, false]) {
      assert.match(stopSafeNoChangeFooterHint(docs), /did not introduce additional changes/);
    }
  });
});

// --- emit_loop_aware_block (per-agent subagent_stop) ----------------------

describe('emitLoopAwareBlock', () => {
  it('hardStops at 3 for the same agent (subagent_stop)', () => {
    const state = { subagent_stop_blocks: { 'agent-a': { count: 2, reason: 'missing files', message: 'm' } } };
    const { output, hardStop } = emitLoopAwareBlock(state, 'subagent_stop', 'missing files', 'm', 'agent-a');
    assert.equal(hardStop, true);
    assert.equal(output.continue, false);
    assert.equal(output.hardStop, true);
  });

  it('does not hardStop across different agents (subagent_stop)', () => {
    // agent-A at count 2; blocking agent-B with the same reason+message -> count 1, not hardStop
    const state = { subagent_stop_blocks: { 'agent-a': { count: 2, reason: 'r', message: 'm' } } };
    const { output, hardStop } = emitLoopAwareBlock(state, 'subagent_stop', 'r', 'm', 'agent-b');
    assert.equal(hardStop, false);
    assert.equal(output.decision, 'block');
    assert.equal(output.hardStop, false);
  });

  it('two different agents each blocked twice -> neither hardStops', () => {
    let state = { subagent_stop_blocks: {} };
    // ADR-0005: the per-agent path returns patch:null and carries the changed
    // entry in perKey; fold it into the map to accumulate across calls.
    const fold = (st, pk) => ({
      ...st,
      subagent_stop_blocks: { ...(st.subagent_stop_blocks || {}), [pk.key]: pk.entry },
    });
    // agent-A: count 1 then 2 (same reason+message)
    let r = emitLoopAwareBlock(state, 'subagent_stop', 'r', 'm', 'agent-a');
    assert.equal(r.hardStop, false);
    assert.equal(r.patch, null);
    state = fold(state, r.perKey);
    r = emitLoopAwareBlock(state, 'subagent_stop', 'r', 'm', 'agent-a');
    assert.equal(r.hardStop, false);
    // agent-B: count 1 then 2 — agent-A's budget must not carry over
    r = emitLoopAwareBlock(state, 'subagent_stop', 'r', 'm', 'agent-b');
    assert.equal(r.hardStop, false);
    state = fold(state, r.perKey);
    r = emitLoopAwareBlock(state, 'subagent_stop', 'r', 'm', 'agent-b');
    assert.equal(r.hardStop, false);
  });

  it('stop prefix hardStop is unchanged (session-global)', () => {
    const state = { stop_block_count: 2, stop_block_reason: 'r', stop_block_message: 'm' };
    const { output, hardStop } = emitLoopAwareBlock(state, 'stop', 'r', 'm');
    assert.equal(hardStop, true);
    assert.equal(output.continue, false);
  });

  it('subagent_stop produces no scalar patch (perKey carries the entry)', () => {
    const state = { subagent_stop_blocks: { 'agent-a': { count: 2, reason: 'r', message: 'm' } } };
    const { patch, perKey } = emitLoopAwareBlock(state, 'subagent_stop', 'r', 'm', 'agent-a');
    assert.equal(patch, null);
    assert.equal(perKey.entry.count, 3);
  });

  it('stop prefix records the patch count via the scalar field', () => {
    const state = { stop_block_count: 1, stop_block_reason: 'r', stop_block_message: 'm' };
    const { patch } = emitLoopAwareBlock(state, 'stop', 'r', 'm');
    assert.equal(patch.stop_block_count, 2);
    assert.equal(patch.stalled_by_policy, false);
  });

  it('carries perKey for a per-agent prefix (ADR 0005)', () => {
    const state = { subagent_stop_blocks: { 'agent-a': { count: 2, reason: 'r', message: 'm' } } };
    const { perKey } = emitLoopAwareBlock(state, 'subagent_stop', 'r', 'm', 'agent-a');
    assert.deepEqual(perKey, {
      mapKey: 'subagent_stop_blocks',
      key: 'agent-a',
      entry: { count: 3, reason: 'r', message: 'm' },
    });
  });

  it('perKey.key uses the _session fallback when agentId is absent (ADR 0005/0006)', () => {
    const { perKey } = emitLoopAwareBlock({ subagent_stop_blocks: {} }, 'subagent_stop', 'r', 'm');
    assert.equal(perKey.key, '_session');
    assert.equal(perKey.mapKey, 'subagent_stop_blocks');
    assert.deepEqual(perKey.entry, { count: 1, reason: 'r', message: 'm' });
  });

  it('perKey is null for a session-global prefix (ADR 0005)', () => {
    const state = { stop_block_count: 1, stop_block_reason: 'r', stop_block_message: 'm' };
    const { perKey } = emitLoopAwareBlock(state, 'stop', 'r', 'm');
    assert.equal(perKey, null);
  });
});

// --- block reason: actionable content, no echoed response -----------------

describe('block checklist content', () => {
  it('keeps the checklist, prefix hints, and template without echoing the response (stop)', () => {
    const message = 'ECHOED_RESPONSE_SENTINEL: I changed the parser but did not run tests.';
    const state = { code_changed: true, task_type: 'feature', docs_required: true, required_subagents: ['cr'], subagents_started: [] };
    const { output } = emitLoopAwareBlock(state, 'stop', 'missing verification evidence', message);
    assert.equal(output.decision, 'block');
    assert.equal(output.reason, 'missing verification evidence');
    const text = output.errorDetails;
    assert.match(text, /### Requirement Checklist/);
    assert.match(text, /Accepted prefixes: `Verification status:`/);
    assert.match(text, /### Minimal Valid Template/);
    assert.match(text, /Verification status: passed\|failed\|not run/);
    assert.doesNotMatch(text, /### Your Current Response/);
    assert.equal(text.includes('ECHOED_RESPONSE_SENTINEL'), false, 'the assistant response text is not echoed');
  });

  it('does not echo the response for a subagent_stop block either', () => {
    const message = 'ECHOED_RESPONSE_SENTINEL: outcome pending.';
    const state = { subagent_stop_blocks: {} };
    const { output } = emitLoopAwareBlock(state, 'subagent_stop', 'missing summary', message, 'agent-a');
    assert.equal(output.decision, 'block');
    assert.match(output.errorDetails, /### Minimal Valid Template/);
    assert.equal(output.errorDetails.includes('ECHOED_RESPONSE_SENTINEL'), false);
  });
});