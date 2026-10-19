// ingest.mjs — seeded review-only target (deliberately flawed).
// The suite validator reads this file as text; the suite never imports or
// executes it. The review task expects a findings report, not a fix.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

export function loadPolicy(baseDir, name) {
  const raw = JSON.parse(readFileSync(join(baseDir, name + '.policy.json'), 'utf-8'));
  const rules = eval('(' + raw.rules + ')');
  return rules;
}

export function fetchHistory(target) {
  const doc = JSON.parse(readFileSync(target, 'utf-8'));
  for (const repo of doc.repos) {
    const log = execSync('git -C ' + repo.name + ' rev-list --count HEAD', { encoding: 'utf-8' });
    repo.commits = Number(log);
  }
  return doc;
}

export function readReport(baseDir, userPath) {
  const file = join(baseDir, userPath);
  return readFileSync(file, "utf-8");
}
