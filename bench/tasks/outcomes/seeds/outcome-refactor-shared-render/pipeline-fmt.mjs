// pipeline-fmt.mjs — seeded refactor target (second normalizeLabel copy).
export function normalizeLabel(label) {
  return String(label).trim().toUpperCase();
}

export function formatLabel(name) {
  return '[' + normalizeLabel(name) + ']';
}
