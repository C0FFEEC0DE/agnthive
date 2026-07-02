import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { renderTitle, renderSubtitle, renderMetric, renderWarning } from './reporter.mjs';
test('renderTitle', () => { assert.equal(renderTitle('  weekly status  '), 'WEEKLY STATUS'); });
test('renderSubtitle', () => { assert.equal(renderSubtitle('  system health  '), 'SYSTEM HEALTH'); });
test('renderMetric', () => { assert.equal(renderMetric(' latency ', 42), 'LATENCY: 42'); });
test('renderWarning', () => { assert.equal(renderWarning(' disk ', 'high'), 'WARNING DISK: high'); });