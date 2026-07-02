import { test } from 'node:test';
import assert from 'node:assert/strict';

// Phase 1 smoke test: confirms the Node test runner is wired into the
// workspace. Real module tests arrive in Phase 1 Tasks 5-6 and beyond.
test('workspace smoke: Node test runner is wired', () => {
  assert.equal(1 + 1, 2);
});