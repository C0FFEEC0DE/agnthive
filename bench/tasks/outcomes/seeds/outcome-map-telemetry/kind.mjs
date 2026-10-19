// kind.mjs — record-kind normalization for the telemetry emitter.
export function normalizeRecordKind(kind) {
  return String(kind || 'metric').trim().toLowerCase();
}
