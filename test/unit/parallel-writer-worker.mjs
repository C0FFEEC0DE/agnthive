// Worker entry for the parallel-writer stress test. Appends `count` increment
// events to a shared session state dir; the parent asserts no lost updates.
import { parentPort, workerData } from 'node:worker_threads';
import { appendEvent, statePaths } from '../../plugins/agent-hive/modules/state.mjs';

const { dataRoot, sessionId, count } = workerData;
const paths = statePaths(dataRoot, sessionId);
for (let i = 0; i < count; i++) {
  appendEvent(paths, 'increment', { field: 'counter', by: 1 });
}
parentPort.postMessage({ done: true, pid: process.pid });