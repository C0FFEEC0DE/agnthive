// Node port of tests/test_statusline.py — tests claudecfg/statusline.sh (the
// dev-profile status line, still shell). Claude Code pipes a JSON session
// object to stdin and the script prints one line `dir | model | style`.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'claudecfg', 'statusline.sh');

function run(stdin, opts = {}) {
  const r = spawnSync('bash', [SCRIPT], {
    input: stdin, encoding: 'utf-8', cwd: opts.cwd || REPO, env: opts.env || process.env,
  });
  return { status: r.status, stdout: r.stdout };
}

function freshDir(label) {
  const d = join(tmpdir(), `sl-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

test('full input with style', () => {
  const d = freshDir('full');
  try {
    const payload = JSON.stringify({ model: { display_name: 'Sonnet 4.6', id: 'claude-sonnet-4-6' }, workspace: { current_dir: d }, output_style: { name: 'Explanatory' } });
    const { status, stdout } = run(payload);
    assert.equal(status, 0);
    assert.equal(stdout, `${basename(d)} | Sonnet 4.6 | Explanatory`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('Default style is elided', () => {
  const d = freshDir('default');
  try {
    const payload = JSON.stringify({ model: { display_name: 'Opus 4.8' }, workspace: { current_dir: d }, output_style: { name: 'Default' } });
    const { status, stdout } = run(payload);
    assert.equal(status, 0);
    assert.equal(stdout, `${basename(d)} | Opus 4.8`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('model.id fallback when no display_name', () => {
  const d = freshDir('idfb');
  try {
    const payload = JSON.stringify({ model: { id: 'claude-haiku-4-5' }, workspace: { current_dir: d } });
    const { status, stdout } = run(payload);
    assert.equal(status, 0);
    assert.equal(stdout, `${basename(d)} | claude-haiku-4-5`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('cwd fallback when no workspace', () => {
  const d = freshDir('cwdfb');
  try {
    const payload = JSON.stringify({ model: { display_name: 'M' }, cwd: d });
    const { status, stdout } = run(payload);
    assert.equal(status, 0);
    assert.equal(stdout, `${basename(d)} | M`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('empty input falls back to PWD basename', () => {
  const d = freshDir('empty');
  try {
    const { status, stdout } = run('', { cwd: d });
    assert.equal(status, 0);
    assert.equal(stdout, basename(d));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('no model no style — just dir', () => {
  const d = freshDir('nomodel');
  try {
    const payload = JSON.stringify({ workspace: { current_dir: d } });
    const { status, stdout } = run(payload, { cwd: d });
    assert.equal(status, 0);
    assert.equal(stdout, basename(d));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('root cwd with model and style', () => {
  const payload = JSON.stringify({ model: { display_name: 'M' }, workspace: { current_dir: '/' }, output_style: { name: 'S' } });
  const { status, stdout } = run(payload);
  assert.equal(status, 0);
  assert.equal(stdout, '/ | M | S');
});

test('empty JSON object uses PWD basename', () => {
  const d = freshDir('emptyobj');
  try {
    const { status, stdout } = run('{}', { cwd: d });
    assert.equal(status, 0);
    assert.equal(stdout, basename(d));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('malformed JSON does not crash', () => {
  const d = freshDir('badjson');
  try {
    const { status, stdout } = run('not-json', { cwd: d });
    assert.equal(status, 0);
    assert.equal(stdout, basename(d));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('jq failing falls back to PWD basename', () => {
  const d = freshDir('jqfail');
  try {
    const bin = join(d, 'bin'); mkdirSync(bin);
    const fakeJq = join(bin, 'jq');
    writeFileSync(fakeJq, '#!/bin/bash\nexit 1\n');
    chmodSync(fakeJq, 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const payload = JSON.stringify({ model: { display_name: 'M' }, workspace: { current_dir: '/should-not-be-used' } });
    const work = join(d, 'work'); mkdirSync(work);
    const r = spawnSync('bash', [SCRIPT], { input: payload, encoding: 'utf-8', env, cwd: work });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, basename(work));
  } finally { rmSync(d, { recursive: true, force: true }); }
});