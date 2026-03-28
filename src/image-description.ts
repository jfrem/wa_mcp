import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface ImageDescription {
  available: boolean;
  description?: string;
  model?: string;
  detail?: string;
}

interface ImageDescriptionPayload {
  imagePath: string;
  prompt?: string;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..");

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

async function resolveReadablePath(candidates: string[], label: string): Promise<string> {
  const attempted = [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
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

async function resolveWorkerScript(): Promise<string | null> {
  const configured = process.env.WHATSAPP_IMAGE_DESCRIBE_SCRIPT?.trim();
  if (!configured) return null;
  return resolveReadablePath(resolvePathCandidates(configured), "Script de descripcion de imagen");
}

export async function describeImageFile(imagePath: string, prompt?: string): Promise<ImageDescription> {
  const absoluteImagePath = await resolveReadablePath(resolvePathCandidates(imagePath), "Archivo de imagen");
  const workerScript = await resolveWorkerScript();

  if (!workerScript) {
    return {
      available: false,
      detail: "No hay worker de descripcion visual configurado. Define WHATSAPP_IMAGE_DESCRIBE_SCRIPT para habilitar descripciones automaticas.",
    };
  }

  const payload: ImageDescriptionPayload = {
    imagePath: absoluteImagePath,
    prompt: prompt?.trim() || undefined,
  };

  let child;
  try {
    child = spawn(process.execPath, [workerScript], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`No se pudo iniciar el worker de descripcion visual: ${message}`);
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
      reject(new Error(`No se pudo iniciar el worker de descripcion visual: ${message}`));
    });
    child.once("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit_code=${exitCode}`;
    throw new Error(`Descripcion visual fallo: ${detail}`);
  }

  try {
    const parsed = JSON.parse(stdout) as { description?: string; model?: string; detail?: string };
    return {
      available: true,
      description: parsed.description?.trim() || "",
      model: parsed.model?.trim() || undefined,
      detail: parsed.detail?.trim() || undefined,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Salida invalida del worker de descripcion visual: ${detail}`);
  }
}
