// pipeline.mjs — seeded refactor target.
// outcome-refactor-shared-render: normalizeLabel is duplicated here and in
// pipeline-fmt.mjs; the task expects it consolidated into one shared module
// imported by both.
export function normalizeLabel(label) {
  return String(label).trim().toUpperCase();
}

export function buildStep(name) {
  return { label: normalizeLabel(name) };
}
