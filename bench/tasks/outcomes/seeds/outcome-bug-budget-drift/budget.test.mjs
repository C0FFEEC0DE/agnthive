import assert from 'node:assert/strict';
import test from 'node:test';
import { subtotal, roundMoney } from './budget.mjs';

test('subtotal matches end-rounded totals on seeded cases', () => {
  assert.equal(subtotal([{ amount: 20, tax: 0 }]), 20);
  assert.equal(subtotal([{ amount: 15.25, tax: 0.08 }]), roundMoney(15.25 * 1.08));
  assert.equal(subtotal([{ amount: 8, tax: 0.1 }, { amount: 8, tax: 0.1 }]), roundMoney(2 * 8 * 1.1));
});
