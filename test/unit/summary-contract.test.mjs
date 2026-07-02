// summary-contract.test.mjs — direct unit coverage for the footer-recognition and
// session-decision functions in plugins/agent-hive/modules/summary-contract.mjs.
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
  sessionManagerIdleReason,
  stopSafeNoChangeFooterHint,
} from '../../plugins/agent-hive/modules/summary-contract.mjs';

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
    const state = { task_type: 'feature', required_subagents: ['cr'], required_subagent_any_of: [['e', 'a']] };
    assert.equal(sessionAgentEnforcementReason(state, ['cr', 'e']), null);
  });

  it('blocks when a one-of group is unsatisfied', () => {
    const state = { task_type: 'feature', required_subagents: ['cr'], required_subagent_any_of: [['e', 'a']] };
    const reason = sessionAgentEnforcementReason(state, ['cr']);
    assert.ok(reason);
    assert.match(reason, /Missing one-of groups: @e\/@a/);
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

  it('skips a required @t when verification already succeeded', () => {
    // @t requirement is satisfied by a successful test run, so it must not block.
    const state = { task_type: 'feature', required_subagents: ['t'], tests_ok: true };
    assert.equal(sessionAgentEnforcementReason(state, []), null);
  });

  it('still requires @t when verification has not succeeded', () => {
    const state = { task_type: 'feature', required_subagents: ['t'] };
    const reason = sessionAgentEnforcementReason(state, []);
    assert.ok(reason);
    assert.match(reason, /Missing required roles: @t/);
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

// --- session_manager_idle_reason ------------------------------------------

describe('sessionManagerIdleReason', () => {
  it('reports an idle manager that has not handed off to any specialist', () => {
    const state = { task_type: 'feature', manager_mode: 'orchestrate' };
    const reason = sessionManagerIdleReason(state, []);
    assert.ok(reason);
    assert.match(reason, /not handed off to any specialist/);
  });

  it('returns null once a specialist handoff has occurred', () => {
    const state = { task_type: 'feature', manager_mode: 'orchestrate' };
    assert.equal(sessionManagerIdleReason(state, ['m', 'cr']), null);
  });

  it('returns null outside orchestrate mode', () => {
    const state = { task_type: 'feature', manager_mode: 'none' };
    assert.equal(sessionManagerIdleReason(state, []), null);
  });

  it('returns null for task types that do not require an implementation summary', () => {
    const state = { task_type: 'other', manager_mode: 'orchestrate' };
    assert.equal(sessionManagerIdleReason(state, []), null);
  });

  it('does not count the manager itself as a specialist', () => {
    // Only @m started (no specialist) should still be treated as idle.
    const state = { task_type: 'feature', manager_mode: 'orchestrate' };
    const reason = sessionManagerIdleReason(state, ['m']);
    assert.ok(reason);
    assert.match(reason, /not handed off to any specialist/);
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