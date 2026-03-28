export interface BotHealthSnapshot {
  updatedAt: string;
  pid: number;
  instanceToken?: string;
}

export function resolveHealthyProcess(
  health: BotHealthSnapshot | null,
  nowMs: number,
  maxAgeMs: number,
  isRunning: (pid: number) => boolean,
): { pid: number; instanceToken: string } | null {
  if (!health) return null;

  const updatedAt = Date.parse(health.updatedAt);
  const pid = Number(health.pid);
  const instanceToken = typeof health.instanceToken === "string" ? health.instanceToken.trim() : "";

  if (!Number.isFinite(updatedAt)) return null;
  if (nowMs - updatedAt > maxAgeMs) return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!instanceToken) return null;
  if (!isRunning(pid)) return null;

  return { pid, instanceToken };
}
