// Node tests for scripts/wait-for-benchmark-slot.mjs (port of the Python test).
// Pure unit tests for ordering, slot logic, rate-limit detection, and retry
// handling via the exported `clock` and `deps` injection points.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  orderActiveRuns, currentRunHasSlot, isGithubRateLimit,
  handleRateLimit, handleTransientError, clock, deps, GithubHttpError,
} from '../../scripts/wait-for-benchmark-slot.mjs';

function fakeHeaders(data) {
  return { get: (k) => data[k] ?? null };
}

test('orderActiveRuns sorted by created_at then id', () => {
  const runs = [
    { id: '200', created_at: '2026-01-01T00:00:02Z' },
    { id: '100', created_at: '2026-01-01T00:00:01Z' },
    { id: '300', created_at: '2026-01-01T00:00:01Z' },
  ];
  assert.deepEqual(orderActiveRuns(runs).map((r) => r.id), ['100', '300', '200']);
});

test('orderActiveRuns missing created_at sorts first', () => {
  const runs = [
    { id: '2' },
    { id: '1', created_at: '2026-01-01T00:00:00Z' },
    { id: '3', created_at: '2026-01-01T00:00:00Z' },
  ];
  assert.deepEqual(orderActiveRuns(runs).map((r) => r.id), ['2', '1', '3']);
});

test('has slot current run in first n', () => {
  const runs = [
    { id: '1', created_at: '2026-01-01T00:00:00Z' },
    { id: '2', created_at: '2026-01-01T00:00:01Z' },
    { id: '3', created_at: '2026-01-01T00:00:02Z' },
  ];
  const [hasSlot, allowed] = currentRunHasSlot({ currentRunId: 2, runs, maxActive: 2 });
  assert.equal(hasSlot, true);
  assert.deepEqual(allowed, [1, 2]);
});

test('has slot current run not in first n', () => {
  const runs = [
    { id: '1', created_at: '2026-01-01T00:00:00Z' },
    { id: '2', created_at: '2026-01-01T00:00:01Z' },
  ];
  const [hasSlot, allowed] = currentRunHasSlot({ currentRunId: 3, runs, maxActive: 2 });
  assert.equal(hasSlot, false);
  assert.deepEqual(allowed, [1, 2]);
});

test('has slot exactly max active', () => {
  const runs = [
    { id: '5', created_at: '2026-01-01T00:00:00Z' },
    { id: '10', created_at: '2026-01-01T00:00:01Z' },
  ];
  const [hasSlot, allowed] = currentRunHasSlot({ currentRunId: 10, runs, maxActive: 2 });
  assert.equal(hasSlot, true);
  assert.deepEqual(allowed, [5, 10]);
});

test('isGithubRateLimit header zero', () => {
  const err = new GithubHttpError(403, fakeHeaders({ 'X-RateLimit-Remaining': '0' }), '{}');
  assert.equal(isGithubRateLimit(err), true);
});

test('isGithubRateLimit body marker', () => {
  const err = new GithubHttpError(403, fakeHeaders({}), '{"message": "rate_limit_exceeded"}');
  assert.equal(isGithubRateLimit(err), true);
});

test('isGithubRateLimit not 403', () => {
  const err = new GithubHttpError(429, fakeHeaders({}), '{}');
  assert.equal(isGithubRateLimit(err), false);
});

test('isGithubRateLimit 403 no marker', () => {
  const err = new GithubHttpError(403, fakeHeaders({}), '{"message": "forbidden"}');
  assert.equal(isGithubRateLimit(err), false);
});

test('handleRateLimit sleeps and returns null', () => {
  let slept = 0;
  const orig = clock.sleep;
  clock.sleep = (s) => { slept = s; };
  try {
    const result = handleRateLimit(new GithubHttpError(403, fakeHeaders({}), ''));
    assert.equal(result, null);
    assert.equal(slept, 60); // default 60s when no Retry-After
  } finally { clock.sleep = orig; }
});

test('handleRateLimit uses Retry-After header', () => {
  let slept = 0;
  const orig = clock.sleep;
  clock.sleep = (s) => { slept = s; };
  try {
    handleRateLimit(new GithubHttpError(403, fakeHeaders({ 'Retry-After': '30' }), ''));
    assert.equal(slept, 30);
  } finally { clock.sleep = orig; }
});

test('handleTransientError retries under max', () => {
  let slept = 0;
  const orig = clock.sleep;
  clock.sleep = (s) => { slept = s; };
  try {
    assert.equal(handleTransientError(new Error('boom'), 0), true);
    assert.ok(slept > 0);
  } finally { clock.sleep = orig; }
});

test('handleTransientError stops at max retries', () => {
  const orig = clock.sleep;
  clock.sleep = () => {};
  try {
    assert.equal(handleTransientError(new Error('boom'), 5), false);
  } finally { clock.sleep = orig; }
});

test('GithubHttpError stores code headers body', () => {
  const e = new GithubHttpError(503, fakeHeaders({}), 'busy');
  assert.equal(e.code, 503);
  assert.equal(e.body, 'busy');
  assert.match(e.message, /HTTP 503/);
});