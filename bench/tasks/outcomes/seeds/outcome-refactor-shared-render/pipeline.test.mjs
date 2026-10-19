import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStep, normalizeLabel } from './pipeline.mjs';
import { formatLabel } from './pipeline-fmt.mjs';

test('pipeline labels are normalized consistently', () => {
  assert.equal(buildStep('  Alpha ').label, 'ALPHA');
  assert.equal(formatLabel(' beta '), '[BETA]');
});
