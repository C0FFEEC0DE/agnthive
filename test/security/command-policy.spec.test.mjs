// command-policy.spec.test.mjs — structural verification of the command-policy
// corpus against plugin references/command-policy.md §7. This is the Task 12 gate: the
// corpus must cover every required category and shell, and every case must be
// well-formed, before the implementation in Task 13 can be held to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORPUS, REQUIRED_CATEGORIES, REQUIRED_SHELLS,
  expandExpectations, structuralViolations,
} from './command-policy.corpus.mjs';

test('corpus is structurally healthy (no violations)', () => {
  const v = structuralViolations();
  assert.deepEqual(v, [], `corpus violations:\n${v.join('\n')}`);
});

test('corpus covers every required category', () => {
  const cats = new Set(CORPUS.map((c) => c.category));
  for (const req of REQUIRED_CATEGORIES) {
    assert.ok(cats.has(req), `missing category: ${req}`);
  }
});

test('corpus covers every required shell where spelling differs', () => {
  const shells = new Set(CORPUS.map((c) => c.shell));
  for (const req of REQUIRED_SHELLS) {
    assert.ok(shells.has(req), `missing shell: ${req}`);
  }
});

test('each required category has at least one positive-deny and one allow case where applicable', () => {
  // quote/escape, subshell, chained-command, environment-assignment, Unicode
  // must each include BOTH a deny and an allow so the gate exercises both
  // branches. positive is deny-only by definition; negative is allow-only.
  const needBoth = ['quote/escape', 'subshell', 'chained-command', 'environment-assignment', 'Unicode'];
  for (const cat of needBoth) {
    const cases = CORPUS.filter((c) => c.category === cat);
    const hasDeny = cases.some((c) => c.decision === 'deny');
    const hasAllow = cases.some((c) => c.decision === 'allow');
    assert.ok(hasDeny, `${cat}: needs at least one deny case`);
    assert.ok(hasAllow, `${cat}: needs at least one allow case`);
  }
});

test('subshell category includes unparseable-indirection cases for both modes', () => {
  // The advisory/enforce mode split (§3, §5) is only exercised by unparseable
  // cases — a literal dangerous verb is denied in both modes.
  const sub = CORPUS.filter((c) => c.category === 'subshell');
  const hasAdvisoryOnly = sub.some((c) => c.mode === 'advisory');
  const hasEnforceOnly = sub.some((c) => c.mode === 'enforce');
  assert.ok(hasAdvisoryOnly, 'subshell: needs an advisory-only (unparseable) case');
  assert.ok(hasEnforceOnly, 'subshell: needs an enforce-only (unparseable) case');
});

test('expandExpectations turns both-mode cases into one advisory + one enforce', () => {
  const exp = expandExpectations();
  // Every 'both' case produces two expectations; mode-specific cases produce one.
  const bothCount = CORPUS.filter((c) => c.mode === 'both').length;
  const specCount = CORPUS.filter((c) => c.mode !== 'both').length;
  assert.equal(exp.length, bothCount * 2 + specCount);
  // Every expectation has a concrete mode (no 'both' leaks through).
  assert.ok(exp.every((e) => e.mode === 'advisory' || e.mode === 'enforce'));
});

test('corpus is large enough to be a meaningful gate', () => {
  // Sanity floor — the corpus should exercise a real spread of cases.
  assert.ok(CORPUS.length >= 60, `corpus has only ${CORPUS.length} cases; expected >= 60`);
});

test('deny reasons reference the spec §6 reason substrings', () => {
  const allowed = ['sudo', 'disk', 'home or current', 'destructive', 'release/deploy', 'remote shell bootstrap', 'could not be statically resolved'];
  for (const c of CORPUS) {
    if (c.decision !== 'deny') continue;
    const ok = allowed.some((a) => c.reasonSubstring.toLowerCase().includes(a));
    assert.ok(ok, `${c.name}: reasonSubstring "${c.reasonSubstring}" not in spec §6 vocabulary`);
  }
});
