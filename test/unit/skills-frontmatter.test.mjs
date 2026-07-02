// Validates YAML frontmatter contract for plugin slash skills under
// plugins/agent-hive/skills/<name>/SKILL.md.
//
// There are two skill shapes:
//  - Agent-backed skills (bug, design, docs, refactor, review, test): full
//    frontmatter — name, description, agent, context: fork,
//    disable-model-invocation: true, non-empty allowed-tools, non-empty
//    paths. The `agent` value must match a known plugin agent name or alias.
//  - Command skills (debug, explore, manager): MINIMAL — only name +
//    description. They must NOT declare agent/context/allowed-tools/paths/
//    disable-model-invocation.
//
// For every skill, the `name` field must equal its directory name.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
const PLUGIN_ROOT = join(REPO, 'plugins', 'agent-hive');
const SKILLS_DIR = join(PLUGIN_ROOT, 'skills');
const AGENT_DIR = join(PLUGIN_ROOT, 'agents');

// readdirSync on a directory, returning sorted child directory names
// (skills are nested as <name>/SKILL.md).
function listSkillDirs(dir) {
  return readdirSync(dir)
    .filter((f) => {
      try { return statSync(join(dir, f)).isDirectory(); } catch { return false; }
    })
    .sort();
}

function listMd(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => join(dir, f))
    .filter((p) => { try { return statSync(p).isFile(); } catch { return false; } })
    .sort();
}

function extractFrontmatter(mdPath) {
  const lines = readFileSync(mdPath, 'utf-8').split('\n');
  assert.ok(lines.length, `${basename(mdPath)}: file is empty`);
  assert.equal(lines[0].trim(), '---', `${basename(mdPath)}: missing frontmatter start delimiter`);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  assert.ok(end !== -1, `${basename(mdPath)}: missing frontmatter end delimiter`);
  if (end + 1 < lines.length) {
    assert.notEqual(lines[end + 1].trim(), '---', `${basename(mdPath)}: duplicate frontmatter block detected`);
  }
  return lines.slice(1, end);
}

function hasField(fm, field) {
  const prefix = `${field}:`;
  return fm.some((l) => l.trim().startsWith(prefix));
}

function extractScalar(fm, field) {
  const prefix = `${field}:`;
  for (const line of fm) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
  }
  return undefined;
}

function extractList(fm, field) {
  const items = [];
  let capture = false;
  for (const line of fm) {
    const stripped = line.trim();
    if (stripped.startsWith(`${field}:`)) {
      const inline = stripped.slice(field.length + 1).trim();
      if (inline) items.push(inline);
      capture = true;
      continue;
    }
    if (capture && stripped.startsWith('- ')) { items.push(stripped.slice(2).trim()); continue; }
    if (capture && stripped && !stripped.startsWith('#')) break;
  }
  return items;
}

// Build the set of known agent names/aliases from plugin agents/*.md.
function knownAgents() {
  const known = new Set();
  for (const af of listMd(AGENT_DIR)) {
    const fm = extractFrontmatter(af);
    const name = extractScalar(fm, 'name');
    const alias = extractScalar(fm, 'alias');
    if (name) known.add(name);
    if (alias) known.add(alias);
  }
  return known;
}

// Collect all skill SKILL.md paths (nested shape: skills/<name>/SKILL.md).
function listSkillFiles() {
  const files = [];
  for (const sub of listSkillDirs(SKILLS_DIR)) {
    const skillMd = join(SKILLS_DIR, sub, 'SKILL.md');
    try { if (statSync(skillMd).isFile()) files.push(skillMd); } catch { /* skip */ }
  }
  return files.sort();
}

const AGENT_BACKED_ONLY_FIELDS = ['context', 'disable-model-invocation', 'allowed-tools', 'paths'];

test('every skill has name + description, and name equals its directory', () => {
  const files = listSkillFiles();
  assert.ok(files.length, `No skills found under ${SKILLS_DIR}`);
  for (const sf of files) {
    const dir = basename(join(sf, '..'));
    const fm = extractFrontmatter(sf);
    const name = extractScalar(fm, 'name');
    assert.ok(name, `${dir}: missing frontmatter field 'name'`);
    assert.equal(name, dir, `${dir}: skill 'name' field must equal its directory name`);
    const desc = extractScalar(fm, 'description');
    assert.ok(desc, `${dir}: missing frontmatter field 'description'`);
    assert.ok(desc.length, `${dir}: description must be non-empty`);
  }
});

test('agent-backed skills carry the full dispatch contract and reference a known agent', () => {
  const known = knownAgents();
  assert.ok(known.size, `No agents found under ${AGENT_DIR}`);
  for (const sf of listSkillFiles()) {
    const dir = basename(join(sf, '..'));
    const fm = extractFrontmatter(sf);
    const agent = extractScalar(fm, 'agent');
    if (agent === undefined) continue; // command skill — covered by the other test
    // agent-backed shape: full contract
    assert.equal(extractScalar(fm, 'context'), 'fork', `${dir}: agent-backed skill must pin context: fork`);
    assert.equal(extractScalar(fm, 'disable-model-invocation'), 'true', `${dir}: agent-backed skill must pin disable-model-invocation: true`);
    const tools = extractList(fm, 'allowed-tools');
    assert.ok(tools.length, `${dir}: agent-backed skill must declare at least one allowed-tools entry`);
    const paths = extractList(fm, 'paths');
    assert.ok(paths.length, `${dir}: agent-backed skill must declare at least one paths entry`);
    assert.ok(known.has(agent), `${dir}: agent '${agent}' must match a known plugin agent name or alias`);
  }
});

test('command skills stay minimal and do not declare agent-backed fields', () => {
  for (const sf of listSkillFiles()) {
    const dir = basename(join(sf, '..'));
    const fm = extractFrontmatter(sf);
    const agent = extractScalar(fm, 'agent');
    if (agent !== undefined) continue; // agent-backed shape — already validated
    for (const field of AGENT_BACKED_ONLY_FIELDS) {
      assert.ok(!hasField(fm, field), `${dir}: command skill must not declare '${field}' (must stay minimal)`);
    }
  }
});