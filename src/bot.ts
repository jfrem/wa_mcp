import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  listUnreadChats,
  readMessages,
  sendMessage,
  waitForActivityEvent,
  waitForWhatsAppReady,
} from "./whatsapp.js";
import { transcribeLatestVoiceNote, type VoiceNoteTranscription } from "./transcription.js";
import { maintainTmpDir } from "./tmp-maintenance.js";
import { buildChatFilterCache, resolveProjectRelativePath, shouldHandleChatName } from "./bot-config.js";
import { computeLoopBackoffMs } from "./bot-runtime.js";
import { resolveResponderModulePath } from "./bot-responder.js";

interface ChatMessage {
  direction: "in" | "out" | "unknown";
  text: string;
  meta: string;
  fingerprintSource?: string;
}

interface ReplyContext {
  chatKey: string;
  chatName: string;
  messages: ChatMessage[];
  systemPrompt: string;
  latestVoiceNote?: VoiceNoteTranscription;
}

type GenerateReply = (context: ReplyContext) => Promise<string | null>;

interface BotConfig {
  enabled: boolean;
  historyLimit: number;
  eventTimeoutMs: number;
  backfillIntervalMs: number;
  cooldownMs: number;
  minInboundChars: number;
  maxReplyChars: number;
  minVoiceTranscriptChars: number;
  maxVoiceNoSpeechProb: number;
  minVoiceAvgLogProb: number;
  dryRun: boolean;
  includeChats: string[];
  includePatterns: string[];
  excludeChats: string[];
  excludePatterns: string[];
  systemPrompt: string;
  logFile: string;
  stateFile: string;
  filterCache: ReturnType<typeof buildChatFilterCache>;
}

interface ChatRuntimeState {
  lastInboundFingerprint?: string;
  lastReplyAt?: number;
  lastSeenAt?: number;
  lastError?: string;
}

interface ChatTarget {
  chatKey: string;
  chatName: string;
}

interface BotState {
  chats: Record<string, ChatRuntimeState>;
}

interface BotHealth {
  status: "booting" | "running" | "error";
  updatedAt: string;
  pid: number;
  instanceToken: string;
  note?: string;
}

const DEFAULT_PORT = Number(process.env.WHATSAPP_WEB_CDP_PORT ?? 9222);
const STATE_DIR = path.join(process.cwd(), "tmp");
const PROJECT_ROOT = process.cwd();
const DEFAULT_CONFIG_PATH = path.join(STATE_DIR, "bot.config.json");
const DEFAULT_STATE_PATH = path.join(STATE_DIR, "bot-state.json");
const DEFAULT_LOG_PATH = path.join(STATE_DIR, "bot-events.log");
const DEFAULT_HEALTH_PATH = path.join(STATE_DIR, "bot-health.json");
const RESPONDERS_DIR = path.join(process.cwd(), "responders");
const INSTANCE_TOKEN = process.env.WHATSAPP_BOT_INSTANCE_TOKEN ?? randomUUID();

function parseCsvEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function ensureDir(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function parseInteger(
  value: unknown,
  fallback: number,
  options: { min?: number; max?: number } = {}
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  if (typeof options.min === "number" && parsed < options.min) return fallback;
  if (typeof options.max === "number" && parsed > options.max) return fallback;
  return parsed;
}

function parseFloatValue(
  value: unknown,
  fallback: number,
  options: { min?: number; max?: number } = {}
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (typeof options.min === "number" && parsed < options.min) return fallback;
  if (typeof options.max === "number" && parsed > options.max) return fallback;
  return parsed;
}

function loadBotConfig(): BotConfig {
  mkdirSync(STATE_DIR, { recursive: true });

  let fileConfig: Partial<BotConfig> = {};
  const configPath = process.env.WHATSAPP_BOT_CONFIG_FILE ?? DEFAULT_CONFIG_PATH;
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf8")) as Partial<BotConfig>;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo parsear la configuracion del bot en ${configPath}: ${detail}`);
    }
  }

  const config: BotConfig = {
    enabled: String(process.env.WHATSAPP_BOT_ENABLED ?? fileConfig.enabled ?? "true") !== "false",
    historyLimit: parseInteger(process.env.WHATSAPP_BOT_HISTORY_LIMIT ?? fileConfig.historyLimit, 12, { min: 1, max: 200 }),
    eventTimeoutMs: parseInteger(process.env.WHATSAPP_BOT_EVENT_TIMEOUT_MS ?? fileConfig.eventTimeoutMs, 300000, { min: 1000, max: 3600000 }),
    backfillIntervalMs: parseInteger(process.env.WHATSAPP_BOT_BACKFILL_MS ?? fileConfig.backfillIntervalMs, 20000, { min: 1000, max: 3600000 }),
    cooldownMs: parseInteger(process.env.WHATSAPP_BOT_COOLDOWN_MS ?? fileConfig.cooldownMs, 45000, { min: 0, max: 3600000 }),
    minInboundChars: parseInteger(process.env.WHATSAPP_BOT_MIN_INBOUND_CHARS ?? fileConfig.minInboundChars, 1, { min: 1, max: 10000 }),
    maxReplyChars: parseInteger(process.env.WHATSAPP_BOT_MAX_REPLY_CHARS ?? fileConfig.maxReplyChars, 2000, { min: 1, max: 20000 }),
    minVoiceTranscriptChars: parseInteger(process.env.WHATSAPP_BOT_MIN_VOICE_TRANSCRIPT_CHARS ?? fileConfig.minVoiceTranscriptChars, 12, { min: 1, max: 10000 }),
    maxVoiceNoSpeechProb: parseFloatValue(
      process.env.WHATSAPP_BOT_MAX_VOICE_NO_SPEECH_PROB ?? fileConfig.maxVoiceNoSpeechProb,
      0.6,
      { min: 0, max: 1 }
    ),
    minVoiceAvgLogProb: parseFloatValue(
      process.env.WHATSAPP_BOT_MIN_VOICE_AVG_LOGPROB ?? fileConfig.minVoiceAvgLogProb,
      -1.2,
      { min: -100, max: 0 }
    ),
    dryRun: String(process.env.WHATSAPP_BOT_DRY_RUN ?? fileConfig.dryRun ?? "false") === "true",
    includeChats: parseCsvEnv(process.env.WHATSAPP_BOT_INCLUDE_CHATS).length
      ? parseCsvEnv(process.env.WHATSAPP_BOT_INCLUDE_CHATS)
      : parseJsonArray(fileConfig.includeChats),
    includePatterns: parseCsvEnv(process.env.WHATSAPP_BOT_INCLUDE_PATTERNS).length
      ? parseCsvEnv(process.env.WHATSAPP_BOT_INCLUDE_PATTERNS)
      : parseJsonArray(fileConfig.includePatterns),
    excludeChats: parseCsvEnv(process.env.WHATSAPP_BOT_EXCLUDE_CHATS).length
      ? parseCsvEnv(process.env.WHATSAPP_BOT_EXCLUDE_CHATS)
      : parseJsonArray(fileConfig.excludeChats),
    excludePatterns: parseCsvEnv(process.env.WHATSAPP_BOT_EXCLUDE_PATTERNS).length
      ? parseCsvEnv(process.env.WHATSAPP_BOT_EXCLUDE_PATTERNS)
      : parseJsonArray(fileConfig.excludePatterns),
    systemPrompt:
      process.env.WHATSAPP_BOT_SYSTEM_PROMPT ??
      fileConfig.systemPrompt ??
      "Responde de forma breve, clara y util. Si falta contexto, pide una aclaracion en una sola pregunta.",
    logFile: resolveProjectRelativePath(
      PROJECT_ROOT,
      process.env.WHATSAPP_BOT_LOG_FILE ?? fileConfig.logFile,
      DEFAULT_LOG_PATH,
    ),
    stateFile: resolveProjectRelativePath(
      PROJECT_ROOT,
      process.env.WHATSAPP_BOT_STATE_FILE ?? fileConfig.stateFile,
      DEFAULT_STATE_PATH,
    ),
    filterCache: buildChatFilterCache([], [], [], []),
  };

  config.filterCache = buildChatFilterCache(
    config.includeChats,
    config.includePatterns,
    config.excludeChats,
    config.excludePatterns,
  );
  ensureDir(config.logFile);
  ensureDir(config.stateFile);
  return config;
}

function loadState(config: BotConfig): BotState {
  if (!existsSync(config.stateFile)) {
    return { chats: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(config.stateFile, "utf8")) as BotState;
    return { chats: parsed.chats ?? {} };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`No se pudo parsear el estado del bot en ${config.stateFile}: ${detail}`);
    return { chats: {} };
  }
}

function saveState(config: BotConfig, state: BotState): void {
  writeFileSync(config.stateFile, JSON.stringify(state, null, 2), "utf8");
}

function logEvent(config: BotConfig, kind: string, payload: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    kind,
    ...payload,
  });
  appendFileSync(config.logFile, `${line}\n`, "utf8");
}

function writeHealth(status: BotHealth["status"], note?: string): void {
  const payload: BotHealth = {
    status,
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    instanceToken: INSTANCE_TOKEN,
    note,
  };
  writeFileSync(DEFAULT_HEALTH_PATH, JSON.stringify(payload, null, 2), "utf8");
}

function shouldHandleChat(config: BotConfig, chatName: string): boolean {
  return shouldHandleChatName(chatName, config.filterCache);
}

function inboundFingerprint(message: ChatMessage): string {
  return (message.fingerprintSource ?? `${message.meta}::${message.text}`).trim();
}

function getLatestInbound(messages: ChatMessage[]): ChatMessage | null {
  return [...messages].reverse().find((message) => message.direction === "in" && message.text.trim()) ?? null;
}

function isVoiceNotePlaceholder(message: ChatMessage | null): boolean {
  return message?.text.trim() === "[Nota de voz]";
}

function truncateReply(config: BotConfig, reply: string): string {
  return reply.length <= config.maxReplyChars ? reply : reply.slice(0, config.maxReplyChars);
}

function isVoiceTranscriptUsable(config: BotConfig, voiceNote: VoiceNoteTranscription): { ok: boolean; reason?: string } {
  const text = voiceNote.transcription.text.trim();
  if (text.length < config.minVoiceTranscriptChars) {
    return { ok: false, reason: "voice_transcript_too_short" };
  }

  const validSegments = voiceNote.transcription.segments.filter((segment) => segment.text.trim());
  if (!validSegments.length) {
    return { ok: false, reason: "voice_transcript_no_segments" };
  }

  const avgNoSpeechProb = validSegments
    .map((segment) => typeof segment.noSpeechProb === "number" ? segment.noSpeechProb : null)
    .filter((value): value is number => value !== null)
    .reduce((sum, value, _, array) => sum + value / array.length, 0);

  const avgLogProb = validSegments
    .map((segment) => typeof segment.avgLogProb === "number" ? segment.avgLogProb : null)
    .filter((value): value is number => value !== null)
    .reduce((sum, value, _, array) => sum + value / array.length, 0);

  if (Number.isFinite(avgNoSpeechProb) && avgNoSpeechProb > config.maxVoiceNoSpeechProb) {
    return { ok: false, reason: "voice_transcript_high_no_speech_probability" };
  }

  if (Number.isFinite(avgLogProb) && avgLogProb < config.minVoiceAvgLogProb) {
    return { ok: false, reason: "voice_transcript_low_confidence" };
  }

  return { ok: true };
}

async function loadResponder(): Promise<GenerateReply> {
  const modulePath = process.env.WHATSAPP_BOT_RESPONDER_MODULE;
  if (!modulePath) {
    return async ({ messages }) => {
      const lastInbound = getLatestInbound(messages);
      if (!lastInbound?.text) return null;
      return `Recibido. Mensaje detectado: "${lastInbound.text.slice(0, 160)}"`;
    };
  }

  const absolutePath = resolveResponderModulePath(RESPONDERS_DIR, modulePath);
  const loaded = await import(pathToFileURL(absolutePath).href);
  if (typeof loaded.generateReply !== "function") {
    throw new Error(`El modulo ${absolutePath} no exporta generateReply(context)`);
  }
  return loaded.generateReply as GenerateReply;
}

async function maybeRespondToChat(
  config: BotConfig,
  state: BotState,
  generateReply: GenerateReply,
  target: ChatTarget
): Promise<void> {
  const { chatKey, chatName } = target;
  if (!shouldHandleChat(config, chatName)) {
    logEvent(config, "skip_chat_rule", { chatName, chatKey });
    return;
  }

  const messages = await readMessages(DEFAULT_PORT, chatName, config.historyLimit, undefined, { chatKey });
  const lastInbound = getLatestInbound(messages);
  if (!lastInbound) {
    logEvent(config, "skip_no_inbound", { chatName, chatKey });
    return;
  }

  if (lastInbound.text.trim().length < config.minInboundChars) {
    logEvent(config, "skip_short_inbound", { chatName, chatKey, text: lastInbound.text });
    return;
  }

  const fingerprint = inboundFingerprint(lastInbound);
  const chatState = state.chats[chatKey] ?? {};
  if (chatState.lastInboundFingerprint === fingerprint) {
    return;
  }

  if (chatState.lastReplyAt && Date.now() - chatState.lastReplyAt < config.cooldownMs) {
    logEvent(config, "skip_cooldown", {
      chatName,
      chatKey,
      cooldownMs: config.cooldownMs,
      remainingMs: config.cooldownMs - (Date.now() - chatState.lastReplyAt),
    });
    return;
  }

  let latestVoiceNote: VoiceNoteTranscription | undefined;
  if (isVoiceNotePlaceholder(lastInbound)) {
    latestVoiceNote = await transcribeLatestVoiceNote(DEFAULT_PORT, chatName, undefined, {}, "in", { chatKey });
    logEvent(config, "voice_note_transcribed", {
      chatName,
      chatKey,
      path: latestVoiceNote.path,
      language: latestVoiceNote.transcription.language,
      durationSeconds: latestVoiceNote.transcription.durationSeconds,
      textLength: latestVoiceNote.transcription.text.length,
      segmentCount: latestVoiceNote.transcription.segments.length,
    });

    const transcriptCheck = isVoiceTranscriptUsable(config, latestVoiceNote);
    if (!transcriptCheck.ok) {
      state.chats[chatKey] = {
        ...chatState,
        lastInboundFingerprint: fingerprint,
        lastSeenAt: Date.now(),
        lastError: transcriptCheck.reason,
      };
      saveState(config, state);
      logEvent(config, "skip_voice_note_low_confidence", {
        chatName,
        chatKey,
        reason: transcriptCheck.reason,
        textLength: latestVoiceNote.transcription.text.length,
        segmentCount: latestVoiceNote.transcription.segments.length,
      });
      return;
    }
  }

  const reply = await generateReply({
    chatKey,
    chatName,
    messages,
    systemPrompt: config.systemPrompt,
    latestVoiceNote,
  });

  state.chats[chatKey] = {
    ...chatState,
    lastInboundFingerprint: fingerprint,
    lastSeenAt: Date.now(),
  };
  saveState(config, state);

  if (!reply || !reply.trim()) {
    logEvent(config, "skip_empty_reply", { chatName, chatKey });
    return;
  }

  const finalReply = truncateReply(config, reply.trim());
  if (config.dryRun) {
    logEvent(config, "dry_run_reply", { chatName, chatKey, reply: finalReply });
    return;
  }

  await sendMessage(DEFAULT_PORT, chatName, finalReply, undefined, { chatKey });
  state.chats[chatKey] = {
    ...state.chats[chatKey],
    lastReplyAt: Date.now(),
    lastError: undefined,
  };
  saveState(config, state);
  logEvent(config, "reply_sent", { chatName, chatKey, reply: finalReply });
}

async function processUnreadChats(
  config: BotConfig,
  state: BotState,
  generateReply: GenerateReply
): Promise<void> {
  const unreadChats = await listUnreadChats(DEFAULT_PORT, 50);
  for (const chat of unreadChats) {
    try {
      await maybeRespondToChat(config, state, generateReply, {
        chatKey: chat.chatKey,
        chatName: chat.title,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      state.chats[chat.chatKey] = {
        ...(state.chats[chat.chatKey] ?? {}),
        lastError: msg,
        lastSeenAt: Date.now(),
      };
      saveState(config, state);
      logEvent(config, "unread_processing_error", { chatName: chat.title, chatKey: chat.chatKey, error: msg });
    }
  }
}

async function main(): Promise<void> {
  maintainTmpDir(STATE_DIR);
  const config = loadBotConfig();
  if (!config.enabled) {
    logEvent(config, "bot_disabled", {});
    return;
  }

  const state = loadState(config);
  const generateReply = await loadResponder();
  let lastBackfillAt = 0;
  let consecutiveFailures = 0;

  logEvent(config, "bot_booting", {
    includeChats: config.includeChats,
    includePatterns: config.includePatterns,
    excludeChats: config.excludeChats,
    excludePatterns: config.excludePatterns,
    dryRun: config.dryRun,
  });
  writeHealth("booting", "Initializing bot process");

  await waitForWhatsAppReady(DEFAULT_PORT, 45000);
  logEvent(config, "bot_started", {
    includeChats: config.includeChats,
    includePatterns: config.includePatterns,
    excludeChats: config.excludeChats,
    excludePatterns: config.excludePatterns,
    dryRun: config.dryRun,
  });
  writeHealth("running", "WhatsApp Web ready");

  await processUnreadChats(config, state, generateReply);

  for (;;) {
    try {
      const activity = await waitForActivityEvent(DEFAULT_PORT, config.eventTimeoutMs);
      consecutiveFailures = 0;
      if (activity?.chatName && activity.chatKey) {
        try {
          await maybeRespondToChat(config, state, generateReply, {
            chatKey: activity.chatKey,
            chatName: activity.chatName,
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          state.chats[activity.chatKey] = {
            ...(state.chats[activity.chatKey] ?? {}),
            lastError: msg,
            lastSeenAt: Date.now(),
          };
          saveState(config, state);
          logEvent(config, "activity_processing_error", { chatName: activity.chatName, chatKey: activity.chatKey, error: msg });
        }
      }

      if (Date.now() - lastBackfillAt >= config.backfillIntervalMs) {
        await processUnreadChats(config, state, generateReply);
        lastBackfillAt = Date.now();
      }

      writeHealth("running", "Event loop healthy");
    } catch (error) {
      consecutiveFailures += 1;
      const delayMs = computeLoopBackoffMs(consecutiveFailures);
      const msg = error instanceof Error ? error.message : String(error);
      logEvent(config, "loop_error", { error: msg, consecutiveFailures, delayMs });
      writeHealth("error", msg);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
