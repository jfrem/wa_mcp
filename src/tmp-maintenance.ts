import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

interface TmpPolicy {
  tmpDir: string;
  maxAudioAgeMs: number;
  maxAudioFiles: number;
  maxTmpBytes: number;
  maxLogBytes: number;
  preservedNames: Set<string>;
  managedDirectoryNames: Set<string>;
}

interface TmpEntry {
  name: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
}

interface StoredReviewTokenLike {
  expiresAt?: string;
}

export interface TmpDirSummary {
  tmpDir: string;
  totalBytes: number;
  files: number;
  directories: number;
  audioFiles: number;
  logFiles: number;
  replyReviewFiles: number;
  preservedEntries: string[];
}

export interface TmpMaintenanceReport {
  mode: "normal" | "prune";
  tmpDir: string;
  deletedFiles: number;
  deletedDirectories: number;
  rotatedLogs: number;
  deletedExpiredReviewTokens: number;
  deletedInvalidReviewTokens: number;
  summary: TmpDirSummary;
}

const DEFAULT_TMP_DIR = path.join(process.cwd(), "tmp");
const AUDIO_FILE_PATTERN = /\.(ogg|opus|mp3|bin)$/i;
const LOG_FILE_PATTERN = /\.(log)$/i;
const REVIEW_TOKEN_DIRNAME = "reply-reviews";

function parseInteger(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
}

function buildPolicy(tmpDir = DEFAULT_TMP_DIR): TmpPolicy {
  return {
    tmpDir,
    maxAudioAgeMs: parseInteger(process.env.WHATSAPP_TMP_MAX_AUDIO_AGE_HOURS, 72, 1) * 60 * 60 * 1000,
    maxAudioFiles: parseInteger(process.env.WHATSAPP_TMP_MAX_AUDIO_FILES, 20, 1),
    maxTmpBytes: parseInteger(process.env.WHATSAPP_TMP_MAX_BYTES_MB, 512, 1) * 1024 * 1024,
    maxLogBytes: parseInteger(process.env.WHATSAPP_TMP_MAX_LOG_BYTES_MB, 10, 1) * 1024 * 1024,
    preservedNames: new Set([
      "bot.config.json",
      "bot-state.json",
      "bot-health.json",
      "bot-daemon.json",
    ]),
    managedDirectoryNames: new Set([
      REVIEW_TOKEN_DIRNAME,
    ]),
  };
}

function safeListDir(dirPath: string): TmpEntry[] {
  mkdirSync(dirPath, { recursive: true });
  try {
    return readdirSync(dirPath, { withFileTypes: true }).flatMap((entry) => {
      try {
        const absolutePath = path.join(dirPath, entry.name);
        const stats = statSync(absolutePath);
        return [{
          name: entry.name,
          absolutePath,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          isDirectory: entry.isDirectory(),
        }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function deleteEntry(entry: TmpEntry): boolean {
  try {
    rmSync(entry.absolutePath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function deletePath(absolutePath: string): boolean {
  try {
    rmSync(absolutePath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function rotateLog(entry: TmpEntry): boolean {
  try {
    const rotated = `${entry.absolutePath}.${Date.now()}.old`;
    renameSync(entry.absolutePath, rotated);
    return true;
  } catch {
    return false;
  }
}

function readReviewTokenExpiry(filePath: string): number | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as StoredReviewTokenLike;
    const expiresAt = Date.parse(String(parsed.expiresAt ?? ""));
    return Number.isFinite(expiresAt) ? expiresAt : null;
  } catch {
    return null;
  }
}

function cleanupReplyReviewDir(
  reviewsDir: string,
  mode: "normal" | "prune",
  now: number,
): { deletedFiles: number; deletedDirectories: number; deletedExpiredReviewTokens: number; deletedInvalidReviewTokens: number } {
  if (mode === "prune") {
    const existed = deletePath(reviewsDir);
    return {
      deletedFiles: 0,
      deletedDirectories: existed ? 1 : 0,
      deletedExpiredReviewTokens: 0,
      deletedInvalidReviewTokens: 0,
    };
  }

  const entries = safeListDir(reviewsDir);
  let deletedFiles = 0;
  let deletedDirectories = 0;
  let deletedExpiredReviewTokens = 0;
  let deletedInvalidReviewTokens = 0;

  for (const entry of entries) {
    if (entry.isDirectory) {
      if (deleteEntry(entry)) deletedDirectories += 1;
      continue;
    }

    const expiresAt = readReviewTokenExpiry(entry.absolutePath);
    if (expiresAt === null) {
      if (deleteEntry(entry)) {
        deletedFiles += 1;
        deletedInvalidReviewTokens += 1;
      }
      continue;
    }

    if (expiresAt <= now && deleteEntry(entry)) {
      deletedFiles += 1;
      deletedExpiredReviewTokens += 1;
    }
  }

  return {
    deletedFiles,
    deletedDirectories,
    deletedExpiredReviewTokens,
    deletedInvalidReviewTokens,
  };
}

function listManagedRootFiles(policy: TmpPolicy): TmpEntry[] {
  return safeListDir(policy.tmpDir)
    .filter((entry) => !policy.preservedNames.has(entry.name))
    .filter((entry) => !entry.isDirectory);
}

function summarizeRecursive(dirPath: string): TmpDirSummary {
  const preservedNames = buildPolicy(dirPath).preservedNames;
  const stack = [dirPath];
  let totalBytes = 0;
  let files = 0;
  let directories = 0;
  let audioFiles = 0;
  let logFiles = 0;
  let replyReviewFiles = 0;

  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of safeListDir(current)) {
      if (entry.isDirectory) {
        directories += 1;
        stack.push(entry.absolutePath);
        continue;
      }

      files += 1;
      totalBytes += entry.size;
      if (AUDIO_FILE_PATTERN.test(entry.name)) audioFiles += 1;
      if (LOG_FILE_PATTERN.test(entry.name)) logFiles += 1;
      if (entry.absolutePath.includes(`${path.sep}${REVIEW_TOKEN_DIRNAME}${path.sep}`)) replyReviewFiles += 1;
    }
  }

  return {
    tmpDir: dirPath,
    totalBytes,
    files,
    directories,
    audioFiles,
    logFiles,
    replyReviewFiles,
    preservedEntries: [...preservedNames].filter((name) => safeListDir(dirPath).some((entry) => entry.name === name)),
  };
}

export function getTmpDirSummary(tmpDir = DEFAULT_TMP_DIR): TmpDirSummary {
  return summarizeRecursive(tmpDir);
}

export function cleanTmpDir(tmpDir = DEFAULT_TMP_DIR, mode: "normal" | "prune" = "normal"): TmpMaintenanceReport {
  const policy = buildPolicy(tmpDir);
  const now = Date.now();
  let deletedFiles = 0;
  let deletedDirectories = 0;
  let rotatedLogs = 0;
  let deletedExpiredReviewTokens = 0;
  let deletedInvalidReviewTokens = 0;

  const entries = safeListDir(policy.tmpDir);
  for (const entry of entries) {
    if (policy.preservedNames.has(entry.name)) continue;

    if (entry.isDirectory) {
      if (policy.managedDirectoryNames.has(entry.name)) {
        const result = cleanupReplyReviewDir(entry.absolutePath, mode, now);
        deletedFiles += result.deletedFiles;
        deletedDirectories += result.deletedDirectories;
        deletedExpiredReviewTokens += result.deletedExpiredReviewTokens;
        deletedInvalidReviewTokens += result.deletedInvalidReviewTokens;
        continue;
      }

      if (deleteEntry(entry)) deletedDirectories += 1;
      continue;
    }

    if (mode === "prune") {
      if (deleteEntry(entry)) deletedFiles += 1;
      continue;
    }

    if (LOG_FILE_PATTERN.test(entry.name) && entry.size > policy.maxLogBytes) {
      if (rotateLog(entry)) rotatedLogs += 1;
    }
  }

  if (mode === "normal") {
    const audioEntries = listManagedRootFiles(policy)
      .filter((entry) => AUDIO_FILE_PATTERN.test(entry.name))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const entry of audioEntries) {
      if (now - entry.mtimeMs > policy.maxAudioAgeMs && deleteEntry(entry)) {
        deletedFiles += 1;
      }
    }

    let remainingAudioEntries = listManagedRootFiles(policy)
      .filter((entry) => AUDIO_FILE_PATTERN.test(entry.name))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    while (remainingAudioEntries.length > policy.maxAudioFiles) {
      const oldest = remainingAudioEntries.shift();
      if (!oldest) break;
      if (!deleteEntry(oldest)) break;
      deletedFiles += 1;
    }

    let entriesByAge = listManagedRootFiles(policy).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let totalBytes = entriesByAge.reduce((sum, entry) => sum + entry.size, 0);
    while (totalBytes > policy.maxTmpBytes && entriesByAge.length) {
      const oldest = entriesByAge.shift();
      if (!oldest) break;
      if (!deleteEntry(oldest)) continue;
      deletedFiles += 1;
      totalBytes -= oldest.size;
    }
  }

  return {
    mode,
    tmpDir: policy.tmpDir,
    deletedFiles,
    deletedDirectories,
    rotatedLogs,
    deletedExpiredReviewTokens,
    deletedInvalidReviewTokens,
    summary: getTmpDirSummary(policy.tmpDir),
  };
}

export function maintainTmpDir(tmpDir = DEFAULT_TMP_DIR): void {
  cleanTmpDir(tmpDir, "normal");
}
