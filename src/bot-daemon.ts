import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { maintainTmpDir } from "./tmp-maintenance.js";
import { resolveHealthyProcess } from "./bot-daemon-health.js";

interface DaemonState {
  pid: number;
  startedAt: string;
  instanceToken: string;
  cwd: string;
  configFile: string;
  stdoutLog: string;
  stderrLog: string;
  healthFile: string;
}

interface BotHealth {
  status: "booting" | "running" | "error";
  updatedAt: string;
  pid: number;
  instanceToken?: string;
  note?: string;
}

const ROOT_DIR = process.cwd();
const TMP_DIR = path.join(ROOT_DIR, "tmp");
const PID_FILE = path.join(TMP_DIR, "bot-daemon.json");
const HEALTH_FILE = path.join(TMP_DIR, "bot-health.json");
const DEFAULT_CONFIG = path.join(TMP_DIR, "bot.config.json");
const STDOUT_LOG = path.join(TMP_DIR, "bot.stdout.log");
const STDERR_LOG = path.join(TMP_DIR, "bot.stderr.log");
const BOT_ENTRY = path.join(ROOT_DIR, "dist", "bot.js");
const BOT_HEALTH_MAX_AGE_MS = Number(process.env.WHATSAPP_BOT_HEALTH_MAX_AGE_MS ?? 120000);

function ensureTmp(): void {
  mkdirSync(TMP_DIR, { recursive: true });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function readState(): DaemonState | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PID_FILE, "utf8")) as DaemonState;
  } catch {
    return null;
  }
}

function writeState(state: DaemonState): void {
  ensureTmp();
  writeFileSync(PID_FILE, JSON.stringify(state, null, 2), "utf8");
}

function readHealth(): BotHealth | null {
  if (!existsSync(HEALTH_FILE)) return null;
  try {
    return JSON.parse(readFileSync(HEALTH_FILE, "utf8")) as BotHealth;
  } catch {
    return null;
  }
}

function clearState(): void {
  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }
}

function print(value: string): void {
  process.stdout.write(`${value}\n`);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readHealthyProcess(minUpdatedAtMs: number): { pid: number; instanceToken: string } | null {
  const health = readHealth();
  const resolved = resolveHealthyProcess(health, Date.now(), BOT_HEALTH_MAX_AGE_MS, isRunning);
  if (!resolved) return null;
  const updatedAt = Date.parse(health?.updatedAt ?? "");
  if (!Number.isFinite(updatedAt) || updatedAt < minUpdatedAtMs) return null;
  return resolved;
}

function recoverStateFromHealth(): DaemonState | null {
  const processInfo = readHealthyProcess(0);
  if (!processInfo) return null;

  const state: DaemonState = {
    pid: processInfo.pid,
    startedAt: new Date().toISOString(),
    instanceToken: processInfo.instanceToken,
    cwd: ROOT_DIR,
    configFile: process.env.WHATSAPP_BOT_CONFIG_FILE ?? DEFAULT_CONFIG,
    stdoutLog: STDOUT_LOG,
    stderrLog: STDERR_LOG,
    healthFile: HEALTH_FILE,
  };
  writeState(state);
  return state;
}

function syncStateWithHealth(existing: DaemonState | null): DaemonState | null {
  const healthProcess = readHealthyProcess(0);
  if (!healthProcess) return existing;

  if (
    existing &&
    existing.instanceToken === healthProcess.instanceToken &&
    existing.pid === healthProcess.pid &&
    isRunning(existing.pid)
  ) {
    return existing;
  }

  const state: DaemonState = {
    pid: healthProcess.pid,
    startedAt: existing?.startedAt ?? new Date().toISOString(),
    instanceToken: healthProcess.instanceToken,
    cwd: existing?.cwd ?? ROOT_DIR,
    configFile: existing?.configFile ?? (process.env.WHATSAPP_BOT_CONFIG_FILE ?? DEFAULT_CONFIG),
    stdoutLog: existing?.stdoutLog ?? STDOUT_LOG,
    stderrLog: existing?.stderrLog ?? STDERR_LOG,
    healthFile: existing?.healthFile ?? HEALTH_FILE,
  };
  writeState(state);
  return state;
}

function resolveActiveState(existing: DaemonState | null): DaemonState | null {
  const synced = syncStateWithHealth(existing);
  const healthProcess = readHealthyProcess(0);
  if (!healthProcess) return synced;

  if (
    synced?.pid === healthProcess.pid &&
    synced.instanceToken === healthProcess.instanceToken
  ) {
    return synced;
  }

  return {
    pid: healthProcess.pid,
    startedAt: synced?.startedAt ?? new Date().toISOString(),
    instanceToken: healthProcess.instanceToken,
    cwd: synced?.cwd ?? ROOT_DIR,
    configFile: synced?.configFile ?? (process.env.WHATSAPP_BOT_CONFIG_FILE ?? DEFAULT_CONFIG),
    stdoutLog: synced?.stdoutLog ?? STDOUT_LOG,
    stderrLog: synced?.stderrLog ?? STDERR_LOG,
    healthFile: synced?.healthFile ?? HEALTH_FILE,
  };
}

function hasMatchingHealthyProcess(state: DaemonState): boolean {
  const healthProcess = readHealthyProcess(0);
  return Boolean(
    healthProcess &&
    healthProcess.pid === state.pid &&
    healthProcess.instanceToken === state.instanceToken
  );
}

function start(): number {
  ensureTmp();
  maintainTmpDir(TMP_DIR);

  const existing = syncStateWithHealth(readState());
  if (existing?.pid && hasMatchingHealthyProcess(existing)) {
    print(`RUNNING pid=${existing.pid}`);
    return 0;
  }

  const recovered = recoverStateFromHealth();
  if (recovered) {
    print(`RUNNING pid=${recovered.pid}`);
    return 0;
  }

  const configFile = process.env.WHATSAPP_BOT_CONFIG_FILE ?? DEFAULT_CONFIG;
  const startedAtMs = Date.now();
  const instanceToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const child = spawn(process.execPath, [BOT_ENTRY], {
    cwd: ROOT_DIR,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      WHATSAPP_BOT_CONFIG_FILE: configFile,
      WHATSAPP_BOT_INSTANCE_TOKEN: instanceToken,
    },
  });

  child.unref();
  let pid = child.pid ?? -1;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const healthyProcess = readHealthyProcess(startedAtMs);
    if (healthyProcess && healthyProcess.instanceToken === instanceToken) {
      pid = healthyProcess.pid;
      break;
    }
    sleepMs(250);
  }

  writeState({
    pid,
    startedAt: new Date().toISOString(),
    instanceToken,
    cwd: ROOT_DIR,
    configFile,
    stdoutLog: STDOUT_LOG,
    stderrLog: STDERR_LOG,
    healthFile: HEALTH_FILE,
  });

  print(`STARTED pid=${pid}`);
  return 0;
}

function stop(): number {
  const existing = resolveActiveState(readState() ?? recoverStateFromHealth());
  if (!existing?.pid) {
    print("STOPPED no_pid");
    return 0;
  }

  if (!existing.instanceToken) {
    print("ERROR missing_instance_token");
    return 1;
  }

  if (!isRunning(existing.pid)) {
    clearState();
    print("STOPPED stale_pid");
    return 0;
  }

  if (!hasMatchingHealthyProcess(existing)) {
    print("ERROR pid_not_owned_by_current_bot_instance");
    return 1;
  }

  try {
    process.kill(existing.pid);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    print(`ERROR ${message}`);
    return 1;
  }

  clearState();
  print(`STOPPED pid=${existing.pid}`);
  return 0;
}

function restart(): number {
  stop();
  return start();
}

function status(): number {
  const existing = resolveActiveState(readState());
  if (!existing?.pid) {
    print("NOT_RUNNING");
    return 0;
  }

  if (!isRunning(existing.pid)) {
    clearState();
    print("NOT_RUNNING stale_pid");
    return 0;
  }

  const health = readHealth();
  const healthyProcess = readHealthyProcess(0);
  if (!healthyProcess || healthyProcess.pid !== existing.pid || healthyProcess.instanceToken !== existing.instanceToken) {
    print(JSON.stringify({
      status: "stale_health",
      ...existing,
      health,
      detail: `No se detecto heartbeat fresco en los ultimos ${BOT_HEALTH_MAX_AGE_MS} ms.`,
    }, null, 2));
    return 0;
  }

  print(JSON.stringify({
    status: "running",
    ...existing,
    health,
  }, null, 2));
  return 0;
}

const command = process.argv[2] ?? "status";

switch (command) {
  case "start":
    process.exitCode = start();
    break;
  case "stop":
    process.exitCode = stop();
    break;
  case "restart":
    process.exitCode = restart();
    break;
  case "status":
    process.exitCode = status();
    break;
  default:
    print("Usage: node dist/bot-daemon.js <start|stop|status>");
    process.exitCode = 1;
    break;
}
