import { realpathSync, statSync } from "node:fs";
import path from "node:path";

const ALLOWED_RESPONDER_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

export function resolveResponderModulePath(respondersDir: string, modulePath: string): string {
  const trimmed = modulePath.trim();
  if (!trimmed) {
    throw new Error("WHATSAPP_BOT_RESPONDER_MODULE no puede estar vacio.");
  }

  const configuredPath = path.resolve(respondersDir, trimmed);
  const respondersRoot = realpathSync(respondersDir);
  const candidateRealPath = realpathSync(configuredPath);
  const respondersPrefix = `${respondersRoot}${path.sep}`;

  if (candidateRealPath !== respondersRoot && !candidateRealPath.startsWith(respondersPrefix)) {
    throw new Error(`El modulo responder debe estar dentro de ${respondersRoot}`);
  }

  const stats = statSync(candidateRealPath);
  if (!stats.isFile()) {
    throw new Error(`El modulo responder debe ser un archivo: ${candidateRealPath}`);
  }

  const extension = path.extname(candidateRealPath).toLowerCase();
  if (!ALLOWED_RESPONDER_EXTENSIONS.has(extension)) {
    throw new Error(`El modulo responder debe usar una extension soportada (${[...ALLOWED_RESPONDER_EXTENSIONS].join(", ")}): ${candidateRealPath}`);
  }

  return candidateRealPath;
}
