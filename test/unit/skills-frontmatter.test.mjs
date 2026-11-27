// Validates YAML frontmatter contract for plugin slash skills under
// plugins/agnthive/skills/<name>/SKILL.md.
//
// Skill shapes after ADR 0015 — every skill is a root procedure:
//  - Root-procedure skills (bug, debug, design, docs, explore, manager,
//    refactor, review, simplify, test): name + description (+ optional
//    argument-hint). They run in the root session, may dispatch a specialist
//    from their body (the `/review` pattern), and must NOT declare
//    agent/context/disable-model-invocation/allowed-tools/paths — a root
//    procedure must not auto-fork an agent.
//  - Forked specialist skills: none ship since ADR 0015 made `/review` a
//    two-stage root procedure. FORKED_SKILLS stays as the seam: any future
//    forked skill must carry the full dispatch frontmatter and match a known
//    plugin agent name or alias.
//  - The five removed compatibility agents (manager, architect, tester,
//    docwriter, bugbuster) are gone from both the agent definitions and the
//    alias map.
//
// For every skill, the `name` field must equal its directory name.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
const PLUGIN_ROOT = join(REPO, 'plugins', 'agnthive');
const SKILLS_DIR = join(PLUGIN_ROOT, 'skills');
const AGENT_DIR = join(PLUGIN_ROOT, 'agents');

// Slash skills that fork a specialist. Empty since ADR 0015; the seam stays
// so a future forked skill is still forced through the dispatch contract.
const FORKED_SKILLS = [];
// Slash skills that are root procedures (run in the root session, delegation
// by need). Complete inventory of the ten shipped skills.
const ROOT_PROCEDURE_SKILLS = ['bug', 'debug', 'design', 'docs', 'explore', 'manager', 'refactor', 'review', 'simplify', 'test'];
const EXPECTED_SKILLS = [...FORKED_SKILLS, ...ROOT_PROCEDURE_SKILLS].sort();

// readdirSync on a directory, returning sorted child directory names
// (skills are nested as <name>/SKILL.md).
function listSkillDirs(dir) {
  return readdirSync(dir)
    .filter((f) => {
      try { return statSync(join(dir, f)).isDirectory(); } catch { return false; }
    })
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

// Collect all skill SKILL.md paths (nested shape: skills/<name>/SKILL.md).
function listSkillFiles() {
  const files = [];
  for (const sub of listSkillDirs(SKILLS_DIR)) {
    const skillMd = join(SKILLS_DIR, sub, 'SKILL.md');
    try { if (statSync(skillMd).isFile()) files.push(skillMd); } catch { /* skip */ }
  }
  return files.sort();
}

const PROCEDURE_ONLY_FIELDS = ['context', 'disable-model-invocation', 'allowed-tools', 'paths'];
const DISPATCH_FIELDS = ['agent', ...PROCEDURE_ONLY_FIELDS];

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

test('skill inventory is exactly the root procedures (no forked skill)', () => {
  const files = listSkillFiles();
  const dirs = files.map((sf) => basename(join(sf, '..'))).sort();
  assert.deepEqual(dirs, EXPECTED_SKILLS, `skills/ directory must be exactly ${JSON.stringify(EXPECTED_SKILLS)}`);
  for (const sf of files) {
    const dir = basename(join(sf, '..'));
    const fm = extractFrontmatter(sf);
    const actual = hasField(fm, 'agent') ? 'forked' : 'root';
    const expected = FORKED_SKILLS.includes(dir) ? 'forked' : 'root';
    assert.equal(actual, expected, `${dir}: expected a ${expected} skill but found ${actual} (declares agent:/none)`);
  }
});

test('the /review skill is a root procedure naming both stages (ADR 0015)', () => {
  const review = join(SKILLS_DIR, 'review', 'SKILL.md');
  const text = readFileSync(review, 'utf-8');
  const body = text.split('---').slice(2).join('---');
  assert.ok(/simplify/i.test(body), '/review body must name the simplify stage');
  assert.ok(/@cr\b|Code Reviewer/.test(body), '/review body must name the Code Reviewer stage');
});

test('any forked specialist skill carries the full dispatch contract and a known agent', () => {
  const known = new Set();
  for (const af of readdirSync(AGENT_DIR).filter((f) => f.endsWith('.md'))) {
    const fm = extractFrontmatter(join(AGENT_DIR, af));
    for (const field of ['name', 'alias']) {
      const v = extractScalar(fm, field);
      if (v) known.add(v);
    }
  }
  for (const sf of listSkillFiles()) {
    const dir = basename(join(sf, '..'));
    if (!FORKED_SKILLS.includes(dir)) continue;
    const fm = extractFrontmatter(sf);
    // Full dispatch contract: this skill forks an isolated specialist.
    const agent = extractScalar(fm, 'agent');
    assert.ok(agent, `${dir}: forked skill must declare 'agent'`);
    assert.equal(extractScalar(fm, 'context'), 'fork', `${dir}: forked skill must pin context: fork`);
    assert.equal(extractScalar(fm, 'disable-model-invocation'), 'true', `${dir}: forked skill must pin disable-model-invocation: true`);
    const tools = extractList(fm, 'allowed-tools');
    assert.ok(tools.length, `${dir}: forked skill must declare at least one allowed-tools entry`);
    const paths = extractList(fm, 'paths');
    assert.ok(paths.length, `${dir}: forked skill must declare at least one paths entry`);
    assert.ok(known.has(agent), `${dir}: agent '${agent}' must match a known plugin agent name or alias`);
    // ADR 0008: the fork target is the read-only primary reviewer.
    assert.equal(agent, 'Code Reviewer', `${dir}: the forked reviewer is the read-only Code Reviewer specialist`);
  }
});

test('root-procedure skills run in the root session and must not auto-fork', () => {
  for (const sf of listSkillFiles()) {
    const dir = basename(join(sf, '..'));
    if (FORKED_SKILLS.includes(dir)) continue; // forked shape — covered by the other test
    const fm = extractFrontmatter(sf);
    for (const field of DISPATCH_FIELDS) {
      assert.ok(!hasField(fm, field), `${dir}: root-procedure skill must not declare '${field}' (procedures run in the root session; delegation is body guidance, never an auto-fork)`);
    }
  }
});