// sinks.mjs — file sinks delegate rotation to logger.mjs.
import { shouldRotate, rotationThresholdBytes } from './logger.mjs';

export function nextSinkFilePath(filePath, sizeInBytes, seq) {
  if (shouldRotate(sizeInBytes, rotationThresholdBytes())) {
    return filePath + '.' + seq;
  }
  return filePath;
}
