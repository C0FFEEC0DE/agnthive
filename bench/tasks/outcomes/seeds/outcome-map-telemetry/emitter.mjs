// emitter.mjs — formats telemetry records; rotation-unaware.
import { normalizeRecordKind } from './kind.mjs';

export function formatRecord(record) {
  const kind = normalizeRecordKind(record.kind);
  return kind + ' ' + record.name + ' ' + record.value;
}
