export function computeLoopBackoffMs(consecutiveFailures: number): number {
  const failures = Math.max(0, Math.trunc(consecutiveFailures));
  if (failures === 0) return 0;
  return Math.min(30_000, failures * 1_000);
}
