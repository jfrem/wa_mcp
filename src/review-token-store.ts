import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ReviewTokenContextOptions {
  tone: "neutral" | "warm" | "brief" | "supportive";
  maxLength: number;
  messageLimit: number;
  mediaLimit: number;
  includeTranscriptions: boolean;
  includeImageDescriptions: boolean;
  direction: "in" | "out" | "any";
  prompt?: string;
  language?: string;
  model?: string;
  beamSize?: number;
  device?: string;
  computeType?: string;
}

export interface StoredReviewToken {
  reviewToken: string;
  createdAt: string;
  expiresAt: string;
  chatName: string;
  chatKey?: string;
  chatIndex?: number;
  draftSignature: string;
  defaultOptionId: string;
  options: ReviewTokenContextOptions;
}

const REVIEW_TOKEN_DIR = path.join(process.cwd(), "tmp", "reply-reviews");
const REVIEW_TOKEN_PATTERN = /^[a-f0-9]{24}$/;

export function assertValidReviewToken(reviewToken: string): string {
  const normalized = reviewToken.trim();
  if (!REVIEW_TOKEN_PATTERN.test(normalized)) {
    throw new Error("review_token invalido. Debe ser un identificador hexadecimal de 24 caracteres.");
  }
  return normalized;
}

export function resolveReviewTokenFile(reviewToken: string): string {
  const normalized = assertValidReviewToken(reviewToken);
  const candidate = path.resolve(REVIEW_TOKEN_DIR, `${normalized}.json`);
  const relative = path.relative(REVIEW_TOKEN_DIR, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("review_token invalido. La ruta resuelta queda fuera del directorio permitido.");
  }
  return candidate;
}

export function createReviewToken(): string {
  return randomBytes(12).toString("hex");
}

export async function saveReviewToken(session: StoredReviewToken): Promise<void> {
  await mkdir(REVIEW_TOKEN_DIR, { recursive: true });
  await writeFile(resolveReviewTokenFile(session.reviewToken), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export async function loadReviewToken(reviewToken: string): Promise<StoredReviewToken | null> {
  try {
    const raw = await readFile(resolveReviewTokenFile(reviewToken), "utf8");
    return JSON.parse(raw) as StoredReviewToken;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: string }).code) : "";
    if (code === "ENOENT") return null;
    throw error;
  }
}

export async function deleteReviewToken(reviewToken: string): Promise<void> {
  await rm(resolveReviewTokenFile(reviewToken), { force: true });
}
