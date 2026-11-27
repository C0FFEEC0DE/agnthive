// ADR 0014: standing-context budgets must measure what a session actually
// pays for. These tests pin the measurement itself, so a parsing regression
// cannot silently disable the budget gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractScalar, standingDescriptionText, CONTEXT_BUDGETS,
} from '../../scripts/validate.mjs';

test('a plain description is measured from its line', () => {
  const fm = ['name: demo', 'description: A short one-liner.'];
  assert.equal(extractScalar(fm, 'description'), 'A short one-liner.');
});

test('a folded block scalar is measured in full, not as the ">" indicator', () => {
  const fm = ['name: demo', 'description: >', '  first line', '  second line'];
  assert.equal(extractScalar(fm, 'description'), 'first line second line');
});

test('a literal block scalar with a chomping indicator is folded too', () => {
  const fm = ['name: demo', 'description: |-', '  kept line one', '  kept line two'];
  assert.equal(extractScalar(fm, 'description'), 'kept line one kept line two');
});

test('a block scalar with an interior blank line keeps measuring past it', () => {
  const fm = ['name: demo', 'description: |', '  visible line', '', '  hidden payload'];
  assert.equal(extractScalar(fm, 'description'), 'visible line hidden payload');
});

test('a plain scalar continued on indented lines is folded', () => {
  const fm = ['name: demo', 'description: first part', '  second part', 'allowed-tools: Read'];
  assert.equal(extractScalar(fm, 'description'), 'first part second part');
  assert.equal(extractScalar(fm, 'allowed-tools'), 'Read', 'the next key is not swallowed');
});

test('a block scalar description cannot ride under the description budget', () => {
  const body = Array.from({ length: 200 }, (_, i) => `  sentence number ${i} about the skill`);
  const fm = ['name: demo', 'description: >', ...body];
  const measured = standingDescriptionText(fm);
  assert.ok(measured.length > CONTEXT_BUDGETS.skillDescriptions,
    `expected the block description to exceed ${CONTEXT_BUDGETS.skillDescriptions}, measured ${measured.length}`);
});

test('plain descriptions stay inside the budget they are measured against', () => {
  const fm = ['name: demo', 'description: Short.'];
  assert.ok(standingDescriptionText(fm).length <= CONTEXT_BUDGETS.agentDescriptions);
});
