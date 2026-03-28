import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { downloadLatestVoiceNote, type DownloadedVoiceNote } from "./whatsapp.js";

export interface TranscriptionSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  avgLogProb?: number | null;
  noSpeechProb?: number | null;
}

export interface AudioTranscription {
  ok: boolean;
  text: string;
  language: string;
  durationSeconds: number;
  model: string;
  segments: TranscriptionSegment[];
}

export interface VoiceNoteTranscription extends DownloadedVoiceNote {
  transcription: AudioTranscription;
}

export interface TranscriptionOptions {
  language?: string;
  model?: string;
  beamSize?: number;
  device?: string;
  computeType?: string;
}

export type VoiceNoteDirection = "in" | "out" | "any";

interface PythonInvocation {
  command: string;
  args: string[];
}

interface WorkerPayload {
  audioPath: string;
  language?: string;
  model: string;
  beamSize: number;
  device: string;
  computeType: string;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..");

function parseExtraArgs(value: string | undefined): string[] {
  return (value ?? "")
    .split(" ")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((candidate) => path.resolve(candidate)))];
}

async function resolveReadablePath(candidates: string[], label: string): Promise<string> {
  const attempted = uniquePaths(candidates);
  for (const candidate of attempted) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  throw new Error(`${label} no encontrado. Rutas intentadas: ${attempted.join(", ")}`);
}

function resolvePathCandidates(inputPath: string): string[] {
  if (path.isAbsolute(inputPath)) {
    return [inputPath];
  }

  return [
    path.resolve(process.cwd(), inputPath),
    path.resolve(PROJECT_ROOT, inputPath),
    path.resolve(MODULE_DIR, inputPath),
  ];
}

function resolvePythonInvocation(): PythonInvocation {
  const override = process.env.WHATSAPP_TRANSCRIBE_PYTHON_BIN?.trim();
  const extraArgs = parseExtraArgs(process.env.WHATSAPP_TRANSCRIBE_PYTHON_ARGS);

  if (override) {
    return { command: override, args: extraArgs };
  }

  const localVenvPython = process.platform === "win32"
    ? uniquePaths([
      path.join(process.cwd(), ".venv", "Scripts", "python.exe"),
      path.join(PROJECT_ROOT, ".venv", "Scripts", "python.exe"),
    ])
    : uniquePaths([
      path.join(process.cwd(), ".venv", "bin", "python"),
      path.join(PROJECT_ROOT, ".venv", "bin", "python"),
    ]);

  const existingLocalVenv = localVenvPython.find((candidate) => existsSync(candidate));
  if (existingLocalVenv) {
    return { command: existingLocalVenv, args: extraArgs };
  }

  if (process.platform === "win32") {
    return { command: "py", args: ["-3", ...extraArgs] };
  }

  return { command: "python3", args: extraArgs };
}

function normalizeOptions(options: TranscriptionOptions = {}): WorkerPayload {
  return {
    audioPath: "",
    language: options.language?.trim() || undefined,
    model: options.model?.trim() || process.env.WHATSAPP_TRANSCRIBE_MODEL?.trim() || "small",
    beamSize: Number.isInteger(options.beamSize) && (options.beamSize ?? 0) > 0
      ? (options.beamSize as number)
      : Number.parseInt(process.env.WHATSAPP_TRANSCRIBE_BEAM_SIZE ?? "5", 10) || 5,
    device: options.device?.trim() || process.env.WHATSAPP_TRANSCRIBE_DEVICE?.trim() || "cpu",
    computeType: options.computeType?.trim() || process.env.WHATSAPP_TRANSCRIBE_COMPUTE_TYPE?.trim() || "int8",
  };
}

export async function transcribeAudioFile(
  audioPath: string,
  options: TranscriptionOptions = {}
): Promise<AudioTranscription> {
  const absoluteAudioPath = await resolveReadablePath(resolvePathCandidates(audioPath), "Archivo de audio");

  const defaultWorkerCandidates = uniquePaths([
    path.join(PROJECT_ROOT, "scripts", "transcribe_faster_whisper.py"),
    path.join(process.cwd(), "scripts", "transcribe_faster_whisper.py"),
    path.join(MODULE_DIR, "..", "scripts", "transcribe_faster_whisper.py"),
  ]);
  const workerScript = await resolveReadablePath(
    process.env.WHATSAPP_TRANSCRIBE_SCRIPT?.trim()
      ? resolvePathCandidates(process.env.WHATSAPP_TRANSCRIBE_SCRIPT.trim())
      : defaultWorkerCandidates,
    "Script de transcripcion"
  );

  const python = resolvePythonInvocation();
  const payload = normalizeOptions(options);
  payload.audioPath = absoluteAudioPath;

  let child;
  try {
    child = spawn(
      python.command,
      [...python.args, workerScript],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`No se pudo iniciar el worker Python (${python.command}): ${message}`);
  }

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      reject(new Error(`No se pudo iniciar el worker Python (${python.command}): ${message}`));
    });
    child.once("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit_code=${exitCode}`;
    throw new Error(`Transcripcion fallo: ${detail}`);
  }

  try {
    return JSON.parse(stdout) as AudioTranscription;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Salida invalida del worker de transcripcion: ${detail}`);
  }
}

export async function transcribeLatestVoiceNote(
  port: number,
  chatName: string,
  chatIndex?: number,
  options: TranscriptionOptions = {},
  direction: VoiceNoteDirection = "any",
  target?: { chatKey?: string; voiceNoteIndex?: number }
): Promise<VoiceNoteTranscription> {
  const downloaded = await downloadLatestVoiceNote(port, chatName, chatIndex, direction, target);
  const transcription = await transcribeAudioFile(downloaded.path, options);
  return {
    ...downloaded,
    transcription,
  };
}
