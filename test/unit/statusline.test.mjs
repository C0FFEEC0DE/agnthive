import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStatusLine } from '../../plugins/agent-hive/scripts/statusline.mjs';

test('normal payload: dir | model | style', () => {
  const out = formatStatusLine({
    model: { display_name: 'Sonnet 4.5' },
    workspace: { current_dir: '/home/me/projects/claude-crew' },
    session_id: 's-1',
    version: '1.0.0',
    output_style: { name: 'Explanatory' },
  });
  assert.equal(out, 'claude-crew | Sonnet 4.5 | Explanatory');
});

test('Default output style is omitted to keep the line short', () => {
  const out = formatStatusLine({
    model: { display_name: 'Opus 4.1' },
    workspace: { current_dir: '/srv/app' },
    output_style: { name: 'Default' },
  });
  assert.equal(out, 'app | Opus 4.1');
});

test('missing fields degrade gracefully without throwing', () => {
  assert.equal(formatStatusLine(null), 'claude');
  assert.equal(formatStatusLine(undefined), 'claude');
  assert.equal(formatStatusLine({}), 'claude');
  assert.equal(formatStatusLine({ model: {} }, { fallbackCwd: '/tmp' }), 'tmp');
  assert.equal(
    formatStatusLine({ model: { display_name: 'Haiku' } }),
    'Haiku',
  );
  assert.equal(
    formatStatusLine({ workspace: { current_dir: '/a/b' } }),
    'b',
  );
  assert.equal(
    formatStatusLine({ output_style: { name: 'Custom' } }),
    'Custom',
  );
});

test('falls back to model.id when display_name is absent', () => {
  const out = formatStatusLine({
    model: { id: 'claude-haiku-4-5' },
    workspace: { current_dir: '/proj' },
  });
  assert.equal(out, 'proj | claude-haiku-4-5');
});

test('falls back to fallbackCwd when workspace is missing', () => {
  const out = formatStatusLine(
    { model: { display_name: 'Sonnet 4.5' } },
    { fallbackCwd: '/var/home/chaos_weaver/code/claude-crew' },
  );
  assert.equal(out, 'claude-crew | Sonnet 4.5');
});

test('Unicode cwd basename is preserved', () => {
  const out = formatStatusLine({
    model: { display_name: 'Sonnet 4.5' },
    workspace: { current_dir: '/home/me/projects/tästå-nîña-日本語' },
    output_style: { name: 'Default' },
  });
  assert.equal(out, 'tästå-nîña-日本語 | Sonnet 4.5');
});

test('output is a single line with no trailing newline', () => {
  const out = formatStatusLine({
    model: { display_name: 'Sonnet 4.5' },
    workspace: { current_dir: '/x/proj' },
    output_style: { name: 'Explanatory' },
  });
  assert.equal(out.includes('\n'), false, 'must not contain a newline');
  assert.equal(out.endsWith('\n'), false, 'must not end with a newline');
  assert.equal(out, 'proj | Sonnet 4.5 | Explanatory');
});

test('non-string fields are ignored, not coerced into the line', () => {
  const out = formatStatusLine({
    model: { display_name: 42 },
    workspace: { current_dir: ['/a', 'b'] },
    output_style: { name: null },
  }, { fallbackCwd: '/a/b' });
  assert.equal(out, 'b');
});