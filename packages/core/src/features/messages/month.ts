export function getUtcMonth(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}
