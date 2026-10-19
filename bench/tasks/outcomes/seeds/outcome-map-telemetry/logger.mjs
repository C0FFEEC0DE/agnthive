// logger.mjs — one module owns log rotation.
export function rotationThresholdBytes() {
  return 1024 * 1024;
}

export function shouldRotate(sizeInBytes, thresholdBytes = rotationThresholdBytes()) {
  return sizeInBytes >= thresholdBytes;
}
