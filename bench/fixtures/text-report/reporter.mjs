// Text rendering fixture used by benchmark tasks.
export function renderTitle(title) { return title.trim().toUpperCase(); }
export function renderSubtitle(subtitle) { return subtitle.trim().toUpperCase(); }
export function renderMetric(label, value) {
  const cleanLabel = label.trim().toUpperCase();
  const cleanValue = String(value).trim();
  return `${cleanLabel}: ${cleanValue}`;
}
export function renderWarning(label, value) {
  const cleanLabel = label.trim().toUpperCase();
  const cleanValue = String(value).trim();
  return `WARNING ${cleanLabel}: ${cleanValue}`;
}