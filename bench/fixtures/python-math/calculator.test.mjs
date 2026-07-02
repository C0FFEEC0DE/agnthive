import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { add, divide } from './calculator.mjs';
test('add', () => { assert.equal(add(2, 3), 5); });
test('divide', () => { assert.equal(divide(8, 2), 4); });