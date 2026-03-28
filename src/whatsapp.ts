import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { CdpSession, ensureWhatsAppTarget, getVersion } from "./cdp.js";
import { maintainTmpDir } from "./tmp-maintenance.js";
import {
  buildSearchInputSelector,
  SEARCH_RESULTS_ARIA_LABELS,
  VOICE_NOTE_CONTROL_LABEL_PATTERNS,
} from "./whatsapp-locators.js";

export interface AuthState {
  ok: boolean;
  state: "authenticated" | "qr_required" | "loading" | "not_whatsapp" | "unknown";
  detail: string;
  chatCount?: number;
}

export interface ChatSummary {
  index: number;
  chatKey: string;
  title: string;
  unreadCount: number;
  lastMessagePreview: string;
  selected: boolean;
}

export interface ChatMessage {
  index: number;
  direction: "in" | "out" | "unknown";
  text: string;
  meta: string;
  fingerprintSource?: string;
  mediaKind?: "image" | "voice_note";
}

export interface ChatActivityEvent {
  type: "unread-chat" | "incoming-message";
  chatName: string;
  chatKey: string;
  unreadCount: number;
  preview: string;
  timestamp: number;
}

export interface SearchResult extends ChatSummary {
  matchReason: "title" | "visible-result";
}

export interface DownloadedVoiceNote {
  path: string;
  mimeType: string;
  blobUrl: string;
  chatName: string;
}

export interface VoiceNoteSummary {
  index: number;
  direction: "in" | "out";
  durationLabel: string;
  meta: string;
  fingerprintSource: string;
}

export interface ImageSummary {
  index: number;
  direction: "in" | "out";
  caption: string;
  meta: string;
  fingerprintSource: string;
}

export interface DownloadedImage {
  path: string;
  mimeType: string;
  sourceUrl: string;
  chatName: string;
  caption: string;
}

export interface CapturedAudioEvent {
  requestId: string;
  url: string;
  mimeType: string;
  type?: string;
}

export interface MessageImageCandidateMeta {
  src: string;
  width?: number;
  height?: number;
  alt?: string;
  hasViewerAffordance?: boolean;
}

export interface LatestMediaPointer {
  message: ChatMessage;
  kind: "image" | "voice_note";
  mediaIndex: number;
}

export interface TimelineMediaPointer extends LatestMediaPointer {
  messageIndex: number;
}

export type MediaDirectionFilter = "in" | "out" | "any";

export type VoiceNoteDirection = "in" | "out" | "any";

export interface AutoAuthOptions {
  port?: number;
  mode?: "connect" | "launch";
  chromePath?: string;
  userDataDir?: string;
  profileDirectory?: string;
  waitForLoginSeconds?: number;
}

const DEFAULT_PORT = Number(process.env.WHATSAPP_WEB_CDP_PORT ?? 9222);
const DEFAULT_PROFILE_DIR = path.join(os.homedir(), ".whatsapp-web-mcp", "chrome-profile");
const DOWNLOADS_DIR = path.join(process.cwd(), "tmp");
const UI_LOCK_PATH = path.join(process.cwd(), "tmp", "whatsapp-ui.lock");
const UI_LOCK_STALE_MS = Number(process.env.WHATSAPP_UI_LOCK_STALE_MS ?? 120000);
const UI_LOCK_WAIT_MS = Number(process.env.WHATSAPP_UI_LOCK_WAIT_MS ?? 15000);
const VOICE_NOTE_SCROLL_STEP_PX = Number(process.env.WHATSAPP_VOICE_NOTE_SCROLL_STEP_PX ?? 900);
const VOICE_NOTE_SCROLL_SETTLE_MS = Number(process.env.WHATSAPP_VOICE_NOTE_SCROLL_SETTLE_MS ?? 700);
const VOICE_NOTE_MAX_SCROLL_STEPS = Number(process.env.WHATSAPP_VOICE_NOTE_MAX_SCROLL_STEPS ?? 12);
const IMAGE_SCROLL_STEP_PX = Number(process.env.WHATSAPP_IMAGE_SCROLL_STEP_PX ?? VOICE_NOTE_SCROLL_STEP_PX);
const IMAGE_SCROLL_SETTLE_MS = Number(process.env.WHATSAPP_IMAGE_SCROLL_SETTLE_MS ?? VOICE_NOTE_SCROLL_SETTLE_MS);
const IMAGE_MAX_SCROLL_STEPS = Number(process.env.WHATSAPP_IMAGE_MAX_SCROLL_STEPS ?? VOICE_NOTE_MAX_SCROLL_STEPS);
const REAL_IMAGE_VIEWER_LABELS = [
  "abrir foto",
  "open photo",
  "abrir imagen",
  "open image",
  "ver foto",
  "view photo",
] as const;
const REAL_IMAGE_MIN_DIMENSION_PX = 96;
const REAL_IMAGE_MIN_AREA_PX = 12_000;
const INLINE_IMAGE_MAX_DIMENSION_PX = 48;
const INLINE_IMAGE_MAX_AREA_PX = 4_096;

function js<T>(fnSource: string, args: unknown[] = []): string {
  return `(${fnSource})(...${JSON.stringify(args)})`;
}

function conversationRootSelector(): string {
  return "div#main";
}

function paneSelector(): string {
  return "#pane-side";
}

function searchInputSelector(): string {
  return buildSearchInputSelector();
}

function filterTablistSelector(): string {
  return "[role='tablist'][aria-label='chat-list-filters']";
}

function chatKeyPartsExpression(rowRef = "row"): string {
  return [
    `${rowRef}.getAttribute("data-id")`,
    `${rowRef}.getAttribute("data-testid")`,
    `Array.from(${rowRef}.querySelectorAll("[data-id], [data-testid]"))
      .map((node) => node.getAttribute("data-id") || node.getAttribute("data-testid") || "")
      .find((value) => String(value).trim())`,
  ].join(" || ");
}

function chatKeyFallbackExpression(titleRef: string, indexRef: string): string {
  return `\`volatile:title::\${String(${titleRef}).trim()}\``;
}

function voiceNoteLabelPatternSources(): string[] {
  return VOICE_NOTE_CONTROL_LABEL_PATTERNS.map((pattern) => pattern.source);
}

function imageExtensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  return "bin";
}

export function buildFallbackChatKey(title: string): string {
  return `volatile:title::${title.trim()}`;
}

export function selectBestAudioEvent(events: CapturedAudioEvent[]): CapturedAudioEvent | null {
  const reversed = [...events].reverse();
  const isAudioLike = (event: CapturedAudioEvent) => /audio|ogg|opus|mpeg|mp3/i.test(`${event.url} ${event.mimeType} ${event.type ?? ""}`);
  const isBlobAudio = (event: CapturedAudioEvent) => event.url.startsWith("blob:") && isAudioLike(event);
  const isStaticAsset = (event: CapturedAudioEvent) => {
    try {
      const parsed = new URL(event.url);
      return parsed.hostname.endsWith("static.whatsapp.net");
    } catch {
      return false;
    }
  };

  const blobAudio = reversed.find(isBlobAudio);
  if (blobAudio) return blobAudio;

  const networkAudio = reversed.find((event) => isAudioLike(event) && !isStaticAsset(event));
  return networkAudio ?? null;
}

export function pickLatestMediaMessage(messages: ChatMessage[]): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.mediaKind === "image" || message?.mediaKind === "voice_note") {
      return message;
    }
  }
  return null;
}

export function pickLatestMediaPointer(messages: ChatMessage[], direction: MediaDirectionFilter = "any"): LatestMediaPointer | null {
  const pointers = buildTimelineMediaPointers(messages, direction);
  const latest = pointers.at(-1);
  if (!latest) return null;
  return {
    message: latest.message,
    kind: latest.kind,
    mediaIndex: latest.mediaIndex,
  };
}

export function buildTimelineMediaPointers(
  messages: ChatMessage[],
  direction: MediaDirectionFilter = "any",
): TimelineMediaPointer[] {
  let imageIndex = 0;
  let voiceNoteIndex = 0;
  const pointers: TimelineMediaPointer[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const matchesDirection =
      direction === "any" ||
      (direction === "in" && message?.direction === "in") ||
      (direction === "out" && message?.direction === "out");
    if (!matchesDirection) continue;
    if (message?.mediaKind === "image") {
      imageIndex += 1;
      pointers.push({
        message,
        kind: "image",
        mediaIndex: imageIndex,
        messageIndex: index,
      });
      continue;
    }
    if (message?.mediaKind === "voice_note") {
      voiceNoteIndex += 1;
      pointers.push({
        message,
        kind: "voice_note",
        mediaIndex: voiceNoteIndex,
        messageIndex: index,
      });
    }
  }

  return pointers.sort((a, b) => a.messageIndex - b.messageIndex);
}

function viewerAffordancePatternSource(): string {
  return REAL_IMAGE_VIEWER_LABELS.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

function inferImageMimeTypeFromSource(src: string): string {
  const normalized = src.trim().toLowerCase();
  const dataMatch = normalized.match(/^data:([^;,]+)/);
  if (dataMatch?.[1]) return dataMatch[1];
  const extensionMatch = normalized.match(/\.([a-z0-9]+)(?:[?#].*)?$/);
  const extension = extensionMatch?.[1] ?? "";
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "";
  }
}

function looksEmojiOnlyText(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  return /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\u200D\uFE0F\s]+$/u.test(normalized);
}

export function isLikelyRealMessageImage(meta: MessageImageCandidateMeta): boolean {
  const src = meta.src.trim();
  if (!src) return false;

  const width = Math.max(0, Number(meta.width) || 0);
  const height = Math.max(0, Number(meta.height) || 0);
  const area = width * height;
  const alt = (meta.alt ?? "").trim();
  const hasViewerAffordance = Boolean(meta.hasViewerAffordance);
  const isBlob = src.startsWith("blob:");
  const isDataImage = /^data:image\//i.test(src);
  const mimeType = inferImageMimeTypeFromSource(src);
  const isTinyInlineAsset =
    width > 0 &&
    height > 0 &&
    (width <= INLINE_IMAGE_MAX_DIMENSION_PX || height <= INLINE_IMAGE_MAX_DIMENSION_PX || area <= INLINE_IMAGE_MAX_AREA_PX);
  const isLargeEnough =
    (width >= REAL_IMAGE_MIN_DIMENSION_PX && height >= REAL_IMAGE_MIN_DIMENSION_PX) ||
    area >= REAL_IMAGE_MIN_AREA_PX;
  const isLikelyEmojiAsset = looksEmojiOnlyText(alt);

  if (isLikelyEmojiAsset && !hasViewerAffordance) return false;
  if (isTinyInlineAsset && !hasViewerAffordance) return false;
  if (isDataImage && mimeType === "image/gif" && !hasViewerAffordance) return false;

  if (hasViewerAffordance) {
    return isBlob || isLargeEnough || /^data:image\/(jpeg|jpg|png|webp)$/i.test(src);
  }

  if (isBlob) return isLargeEnough;
  if (isDataImage) return false;
  return isLargeEnough;
}

function imageDetectionHelpersSource(): string {
  return `
    () => {
      const viewerAffordancePattern = new RegExp(${JSON.stringify(viewerAffordancePatternSource())}, "i");
      const inferImageMimeTypeFromSource = (src) => {
        const normalized = String(src || "").trim().toLowerCase();
        const dataMatch = normalized.match(/^data:([^;,]+)/);
        if (dataMatch && dataMatch[1]) return dataMatch[1];
        const extensionMatch = normalized.match(/\\.([a-z0-9]+)(?:[?#].*)?$/);
        const extension = extensionMatch && extensionMatch[1] ? extensionMatch[1] : "";
        switch (extension) {
          case "jpg":
          case "jpeg":
            return "image/jpeg";
          case "png":
            return "image/png";
          case "webp":
            return "image/webp";
          case "gif":
            return "image/gif";
          default:
            return "";
        }
      };
      const looksEmojiOnlyText = (value) => {
        const normalized = String(value || "").trim();
        if (!normalized) return false;
        return /^[\\p{Extended_Pictographic}\\p{Emoji_Presentation}\\u200D\\uFE0F\\s]+$/u.test(normalized);
      };
      const isLikelyRealMessageImage = (img, hasViewerAffordance) => {
        if (!(img instanceof HTMLImageElement)) return false;
        const src = (img.currentSrc || img.getAttribute("src") || "").trim();
        if (!src) return false;
        const width = Math.max(0, Number(img.naturalWidth || img.width || 0));
        const height = Math.max(0, Number(img.naturalHeight || img.height || 0));
        const area = width * height;
        const alt = (img.getAttribute("alt") || img.alt || "").trim();
        const isBlob = src.startsWith("blob:");
        const isDataImage = /^data:image\\//i.test(src);
        const mimeType = inferImageMimeTypeFromSource(src);
        const isTinyInlineAsset = width > 0 && height > 0 && (width <= ${INLINE_IMAGE_MAX_DIMENSION_PX} || height <= ${INLINE_IMAGE_MAX_DIMENSION_PX} || area <= ${INLINE_IMAGE_MAX_AREA_PX});
        const isLargeEnough = (width >= ${REAL_IMAGE_MIN_DIMENSION_PX} && height >= ${REAL_IMAGE_MIN_DIMENSION_PX}) || area >= ${REAL_IMAGE_MIN_AREA_PX};
        const isLikelyEmojiAsset = looksEmojiOnlyText(alt);

        if (isLikelyEmojiAsset && !hasViewerAffordance) return false;
        if (isTinyInlineAsset && !hasViewerAffordance) return false;
        if (isDataImage && mimeType === "image/gif" && !hasViewerAffordance) return false;

        if (hasViewerAffordance) {
          return isBlob || isLargeEnough || /^data:image\\/(jpeg|jpg|png|webp)$/i.test(src);
        }

        if (isBlob) return isLargeEnough;
        if (isDataImage) return false;
        return isLargeEnough;
      };
      const getRowViewerLabels = (row) =>
        Array.from(row.querySelectorAll("[aria-label]"))
          .map((node) => node.getAttribute("aria-label") || "")
          .filter(Boolean);
      const rowHasViewerAffordance = (row) => getRowViewerLabels(row).some((label) => viewerAffordancePattern.test(label));
      const getMessageImageCandidates = (row) => {
        if (!(row instanceof HTMLElement)) return [];
        const hasViewerAffordance = rowHasViewerAffordance(row);
        return Array.from(row.querySelectorAll("img[src]")).filter((img) => isLikelyRealMessageImage(img, hasViewerAffordance));
      };
      const rowHasRealImage = (row) => getMessageImageCandidates(row).length > 0;
      return { getMessageImageCandidates, rowHasRealImage };
    }
  `;
}

async function withWhatsAppSession<T>(port: number, handler: (session: CdpSession) => Promise<T>): Promise<T> {
  await getVersion(port);
  const target = await ensureWhatsAppTarget(port);
  if (!target.webSocketDebuggerUrl) {
    throw new Error("No se encontro webSocketDebuggerUrl para WhatsApp Web");
  }
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  try {
    return await handler(session);
  } finally {
    await session.close();
  }
}

function readLockOwner(): string | null {
  try {
    return readFileSync(UI_LOCK_PATH, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function isLockStale(): boolean {
  try {
    return Date.now() - statSync(UI_LOCK_PATH).mtimeMs > UI_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

export async function runWithWhatsAppUiLock<T>(label: string, handler: () => Promise<T>): Promise<T> {
  mkdirSync(path.dirname(UI_LOCK_PATH), { recursive: true });
  const owner = `${process.pid}:${Date.now()}:${label}`;
  const deadline = Date.now() + UI_LOCK_WAIT_MS;

  for (;;) {
    try {
      writeFileSync(UI_LOCK_PATH, owner, { encoding: "utf8", flag: "wx" });
      break;
    } catch (error) {
      if (isLockStale()) {
        try {
          unlinkSync(UI_LOCK_PATH);
          continue;
        } catch {
          // Another process may have already replaced the stale lock.
        }
      }

      if (Date.now() >= deadline) {
        const currentOwner = readLockOwner() ?? "unknown";
        throw new Error(`WhatsApp Web esta ocupado por otra operacion (${currentOwner}).`);
      }

      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code && code !== "EEXIST") {
        throw error;
      }
      await sleep(250);
    }
  }

  try {
    return await handler();
  } finally {
    if (readLockOwner() === owner) {
      try {
        unlinkSync(UI_LOCK_PATH);
      } catch {
        // Best effort cleanup.
      }
    }
  }
}

async function connectWhatsAppSession(port: number): Promise<CdpSession> {
  await getVersion(port);
  const target = await ensureWhatsAppTarget(port);
  if (!target.webSocketDebuggerUrl) {
    throw new Error("No se encontro webSocketDebuggerUrl para WhatsApp Web");
  }
  return CdpSession.connect(target.webSocketDebuggerUrl);
}

export async function launchChromeForWhatsApp(options: AutoAuthOptions = {}): Promise<void> {
  const port = options.port ?? DEFAULT_PORT;
  const chromePath =
    options.chromePath ??
    process.env.CHROME_PATH ??
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const userDataDir = options.userDataDir ?? DEFAULT_PROFILE_DIR;

  mkdirSync(userDataDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--new-window",
    "https://web.whatsapp.com",
  ];

  if (options.profileDirectory) {
    args.splice(2, 0, `--profile-directory=${options.profileDirectory}`);
  }

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await sleep(1500);
}

export async function checkAuth(port = DEFAULT_PORT): Promise<AuthState> {
  return withWhatsAppSession(port, async (session) => {
    return session.evaluate<AuthState>(js(`
      () => {
        const href = window.location.href;
        if (!href.startsWith("https://web.whatsapp.com")) {
          return { ok: false, state: "not_whatsapp", detail: "La pestaña activa no es WhatsApp Web." };
        }

        const bodyText = document.body?.innerText ?? "";
        const qrCanvas = document.querySelector("canvas[aria-label], canvas");
        const sidePane = document.querySelector("#pane-side");
        const loading = document.querySelector("[role='progressbar'], div[data-animate-loading='true']");
        const loginByPhone = Array.from(document.querySelectorAll("button, div, span, a"))
          .some((node) => {
            const text = node.textContent ?? "";
            return text.includes("Iniciar sesión con número de teléfono") || text.includes("Log in with phone number");
          });
        const scanQrText =
          bodyText.includes("Escanea para iniciar sesión") ||
          bodyText.includes("Escanea el código QR") ||
          bodyText.includes("Scan to log in") ||
          bodyText.includes("Scan the QR code");

        if (sidePane) {
          const rows = sidePane.querySelectorAll("div[role='listitem'], div[role='gridcell']");
          return {
            ok: true,
            state: "authenticated",
            detail: "Sesion activa en WhatsApp Web.",
            chatCount: rows.length
          };
        }

        if ((qrCanvas || loginByPhone || scanQrText) && !sidePane) {
          return { ok: false, state: "qr_required", detail: "Se requiere escanear el QR de WhatsApp Web." };
        }

        if (loading) {
          return { ok: false, state: "loading", detail: "WhatsApp Web sigue cargando." };
        }

        return { ok: false, state: "unknown", detail: "No se pudo determinar el estado de autenticacion." };
      }
    `));
  });
}

export async function autoAuth(options: AutoAuthOptions = {}): Promise<AuthState> {
  const port = options.port ?? DEFAULT_PORT;
  const mode = options.mode ?? "connect";
  const waitSeconds = options.waitForLoginSeconds ?? 60;

  if (mode === "launch") {
    await launchChromeForWhatsApp(options);
  }

  const deadline = Date.now() + waitSeconds * 1000;
  let lastState: AuthState = {
    ok: false,
    state: "loading",
    detail: "Esperando a que WhatsApp Web quede listo.",
  };

  while (Date.now() < deadline) {
    try {
      lastState = await checkAuth(port);
      if (lastState.ok) return lastState;
    } catch (error) {
      lastState = {
        ok: false,
        state: "loading",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    await sleep(2000);
  }

  return lastState;
}

async function requireAuth(port: number): Promise<void> {
  const auth = await checkAuth(port);
  if (!auth.ok) {
    throw new Error(`WhatsApp Web sin auth valida: ${auth.detail}`);
  }
}

async function clickPoint(session: CdpSession, x: number, y: number): Promise<void> {
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function focusSearchInput(session: CdpSession): Promise<void> {
  const point = await session.evaluate<{ x: number; y: number } | null>(js(`
    () => {
      const input = Array.from(document.querySelectorAll(${JSON.stringify(searchInputSelector())}))
        .find((node) => node instanceof HTMLInputElement && !node.closest(${JSON.stringify(conversationRootSelector())}));
      if (!input) return null;
      const rect = input.getBoundingClientRect();
      return { x: rect.left + Math.min(rect.width / 2, 40), y: rect.top + rect.height / 2 };
    }
  `));
  if (!point) {
    throw new Error("No se encontro el buscador de chats de WhatsApp Web.");
  }
  await clickPoint(session, point.x, point.y);
}

async function pressKey(session: CdpSession, key: string, options?: { code?: string; modifiers?: number; text?: string }): Promise<void> {
  const code = options?.code ?? key;
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined,
    nativeVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined,
    modifiers: options?.modifiers ?? 0,
    text: options?.text,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined,
    nativeVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined,
    modifiers: options?.modifiers ?? 0,
  });
}

async function setSearchQuery(session: CdpSession, query: string): Promise<void> {
  await focusSearchInput(session);
  const ok = await session.evaluate<boolean>(js(`
    () => {
      const input = Array.from(document.querySelectorAll(${JSON.stringify(searchInputSelector())}))
        .find((node) => node instanceof HTMLInputElement && !node.closest(${JSON.stringify(conversationRootSelector())}));
      if (!(input instanceof HTMLInputElement)) return false;
      input.focus();
      return document.activeElement === input;
    }
  `));
  if (!ok) {
    throw new Error("No se pudo escribir en el buscador de chats.");
  }
  await pressKey(session, "a", { code: "KeyA", modifiers: 2 });
  await pressKey(session, "Backspace", { code: "Backspace" });
  if (query) {
    await session.send("Input.insertText", { text: query });
  }
  await sleep(800);
}

export async function clearSearch(port = DEFAULT_PORT): Promise<void> {
  await runWithWhatsAppUiLock("clear_search", async () => {
    await requireAuth(port);
    await withWhatsAppSession(port, async (session) => {
      await setSearchQuery(session, "");
    });
  });
}

export async function applyChatFilter(port = DEFAULT_PORT, filterName = "Todos"): Promise<void> {
  await runWithWhatsAppUiLock("apply_chat_filter", async () => {
    await requireAuth(port);
    await withWhatsAppSession(port, async (session) => {
      const point = await session.evaluate<{ x: number; y: number } | null>(js(`
        (filterName) => {
          const tablist = document.querySelector(${JSON.stringify(filterTablistSelector())});
          if (!tablist) return null;
          const tabs = Array.from(tablist.querySelectorAll("button[role='tab'], button"));
          const target = tabs.find((tab) => (tab.textContent ?? "").trim().toLowerCase() === String(filterName).trim().toLowerCase());
          if (!(target instanceof HTMLElement)) return null;
          const rect = target.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
      `, [filterName]));
      if (!point) {
        throw new Error(`No se encontro el filtro "${filterName}" en WhatsApp Web.`);
      }
      await clickPoint(session, point.x, point.y);
    });
    await sleep(800);
  });
}

export async function listChats(port = DEFAULT_PORT, limit = 30): Promise<ChatSummary[]> {
  await requireAuth(port);
  return withWhatsAppSession(port, async (session) => {
    return session.evaluate<ChatSummary[]>(js(`
      (limit) => {
        const topLevelRows = (root) => Array.from(
          root.querySelectorAll("div[role='listitem'], div[role='gridcell']")
        ).filter((row) => !row.parentElement?.closest("div[role='listitem'], div[role='gridcell']"));

        const pane = document.querySelector(${JSON.stringify(paneSelector())});
        if (!pane) return [];

        const candidates = topLevelRows(pane);

        const rows = candidates
          .map((row, index) => {
            const titleNode =
              row.querySelector("span[title]") ||
              row.querySelector("img[alt]") ||
              row.querySelector("[dir='auto']");
            const title =
              titleNode?.getAttribute?.("title") ||
              titleNode?.getAttribute?.("alt") ||
              titleNode?.textContent ||
              "";

            const previewNode = Array.from(row.querySelectorAll("span"))
              .map((node) => node.textContent?.trim() ?? "")
              .filter(Boolean)
              .find((text) => text !== title);

            const unreadNode =
              row.querySelector("[aria-label*='unread']") ||
              row.querySelector("[data-testid='icon-unread-count']") ||
              Array.from(row.querySelectorAll("span")).find((span) => /^\\d+$/.test(span.textContent?.trim() ?? ""));

            const unreadText = unreadNode?.textContent?.trim() ?? "";
            const unreadCount = /^\\d+$/.test(unreadText) ? Number(unreadText) : 0;
            const selected = row.getAttribute("aria-selected") === "true";
            const chatKey =
              ${chatKeyPartsExpression()} ||
              ${chatKeyFallbackExpression("title", "index + 1")};

            return {
              chatKey: String(chatKey).trim(),
              title: title.trim(),
              unreadCount,
              lastMessagePreview: (previewNode ?? "").trim(),
              selected,
            };
          })
          .filter((row) => row.title);

        return rows.slice(0, limit).map((row, index) => ({
          index: index + 1,
          ...row
        }));
      }
    `, [limit]));
  });
}

export async function listUnreadChats(port = DEFAULT_PORT, limit = 20): Promise<ChatSummary[]> {
  const chats = await listChats(port, Math.max(limit * 3, limit));
  return chats.filter((chat) => chat.unreadCount > 0).slice(0, limit);
}

export async function searchChats(port = DEFAULT_PORT, query: string, limit = 20): Promise<SearchResult[]> {
  return runWithWhatsAppUiLock("search_chats", async () => {
    await requireAuth(port);
    return withWhatsAppSession(port, async (session) => {
      await setSearchQuery(session, query);
      const results = await session.evaluate<SearchResult[]>(js(`
      (limit) => {
        const topLevelRows = (root) => Array.from(
          root.querySelectorAll("div[role='listitem'], div[role='gridcell']")
        ).filter((row) => !row.parentElement?.closest("div[role='listitem'], div[role='gridcell']"));
        const pane = document.querySelector(${JSON.stringify(paneSelector())});
        if (!(pane instanceof HTMLElement)) return [];

        const visibleRows = topLevelRows(pane);
        const rows = visibleRows
          .filter((row) => row.querySelector("span[title], img[alt], [dir='auto']"))
          .map((row) => {
          const titleNode =
            row.querySelector("span[title]") ||
            row.querySelector("img[alt]") ||
            row.querySelector("[dir='auto']");
          const title =
            titleNode?.getAttribute?.("title") ||
            titleNode?.getAttribute?.("alt") ||
            titleNode?.textContent ||
            "";
          const previewNode = Array.from(row.querySelectorAll("span"))
            .map((node) => node.textContent?.trim() ?? "")
            .filter(Boolean)
            .find((text) => text !== title);
          const unreadNode =
            row.querySelector("[aria-label*='unread']") ||
            row.querySelector("[data-testid='icon-unread-count']") ||
            Array.from(row.querySelectorAll("span")).find((span) => /^\\d+$/.test(span.textContent?.trim() ?? ""));
          const unreadText = unreadNode?.textContent?.trim() ?? "";
          const unreadCount = /^\\d+$/.test(unreadText) ? Number(unreadText) : 0;
          const rowIndex = visibleRows.indexOf(row) + 1;
          const chatKey =
            ${chatKeyPartsExpression()} ||
            ${chatKeyFallbackExpression("title", "rowIndex")};
          return {
            chatKey: String(chatKey).trim(),
            title: title.trim(),
            unreadCount,
            lastMessagePreview: (previewNode ?? "").trim(),
            selected: row.getAttribute("aria-selected") === "true",
            matchReason: "visible-result"
          };
        }).filter((row) => row.title);

        return rows.slice(0, limit).map((row, index) => ({
          index: index + 1,
          ...row
        }));
      }
    `, [limit]));
      return results;
    });
  });
}

async function locateSidebarChatByKey(
  session: CdpSession,
  chatKey: string,
): Promise<{ x: number; y: number } | null> {
  if (!chatKey.trim()) return null;

  const resetToTop = async () => {
    await session.evaluate(js(`
      () => {
        const pane = document.querySelector(${JSON.stringify(paneSelector())});
        if (pane instanceof HTMLElement) {
          pane.scrollTop = 0;
        }
      }
    `));
  };

  const scanCurrentViewport = async () => {
    return session.evaluate<{ point: { x: number; y: number } | null; canScrollMore: boolean }>(js(`
      (chatKey) => {
        const topLevelRows = (root) => Array.from(
          root.querySelectorAll("div[role='listitem'], div[role='gridcell']")
        ).filter((row) => !row.parentElement?.closest("div[role='listitem'], div[role='gridcell']"));

        const pane = document.querySelector(${JSON.stringify(paneSelector())});
        if (!(pane instanceof HTMLElement)) {
          return { point: null, canScrollMore: false };
        }

        const rows = topLevelRows(pane);
        const target = rows.find((row, index) => {
          const titleNode =
            row.querySelector("span[title]") ||
            row.querySelector("img[alt]") ||
            row.querySelector("[dir='auto']");
          const title =
            titleNode?.getAttribute?.("title") ||
            titleNode?.getAttribute?.("alt") ||
            titleNode?.textContent ||
            "";
          const candidateKey =
            ${chatKeyPartsExpression()} ||
            ${chatKeyFallbackExpression("title", "index + 1")};
          return String(candidateKey).trim() === String(chatKey).trim();
        });

        if (target instanceof HTMLElement) {
          target.scrollIntoView({ block: "center" });
          const rect = target.getBoundingClientRect();
          return {
            point: {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
            },
            canScrollMore: pane.scrollTop + pane.clientHeight + 8 < pane.scrollHeight,
          };
        }

        return {
          point: null,
          canScrollMore: pane.scrollTop + pane.clientHeight + 8 < pane.scrollHeight,
        };
      }
    `, [chatKey]));
  };

  const advanceViewport = async () => {
    return session.evaluate<boolean>(js(`
      () => {
        const pane = document.querySelector(${JSON.stringify(paneSelector())});
        if (!(pane instanceof HTMLElement)) return false;
        const previousTop = pane.scrollTop;
        pane.scrollTop = Math.min(
          pane.scrollHeight - pane.clientHeight,
          pane.scrollTop + Math.max(240, Math.floor(pane.clientHeight * 0.8))
        );
        return pane.scrollTop > previousTop;
      }
    `));
  };

  await resetToTop();
  await sleep(250);

  let staleSteps = 0;
  for (let step = 0; step < 80; step += 1) {
    const scan = await scanCurrentViewport();
    if (scan.point) {
      return scan.point;
    }
    if (!scan.canScrollMore) {
      return null;
    }
    const moved = await advanceViewport();
    if (!moved) {
      staleSteps += 1;
      if (staleSteps >= 2) {
        return null;
      }
    } else {
      staleSteps = 0;
    }
    await sleep(250);
  }

  return null;
}

async function openChat(
  port: number,
  chatName: string,
  chatIndex?: number,
  options?: { useSearch?: boolean; chatKey?: string }
): Promise<void> {
  await requireAuth(port);
  await withWhatsAppSession(port, async (session) => {
    let targetPoint =
      !options?.useSearch && options?.chatKey
        ? await locateSidebarChatByKey(session, options.chatKey)
        : null;

    const locateTargetPoint = async (useSearch: boolean) => {
      if (useSearch) {
        await setSearchQuery(session, chatName);
      }
      return session.evaluate<{ x: number; y: number } | null>(js(`
      (chatName, chatIndex, useSearch, chatKey) => {
        const topLevelRows = (root) => Array.from(
          root.querySelectorAll("div[role='listitem'], div[role='gridcell']")
        ).filter((row) => !row.parentElement?.closest("div[role='listitem'], div[role='gridcell']"));
        const pane = document.querySelector(${JSON.stringify(paneSelector())});
        if (!(pane instanceof HTMLElement)) return null;

        const visibleRows = topLevelRows(pane);
        const rows = useSearch ? visibleRows : visibleRows.filter((row, index) => {
          const titleNode =
            row.querySelector("span[title]") ||
            row.querySelector("img[alt]") ||
            row.querySelector("[dir='auto']");
          const title =
            titleNode?.getAttribute?.("title") ||
            titleNode?.getAttribute?.("alt") ||
            titleNode?.textContent ||
            "";
          const candidateKey =
            ${chatKeyPartsExpression()} ||
            \`${"${index + 1}"}::\${title.trim()}\`;
          if (String(chatKey || "").trim()) {
            return String(candidateKey).trim() === String(chatKey).trim();
          }
          return title.trim() === chatName.trim();
        });

        const target = typeof chatIndex === "number" && chatIndex > 0
          ? rows[chatIndex - 1]
          : rows[0];

        if (!target) return null;
        target.scrollIntoView({ block: "center" });
        const rect = target.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        };
      }
    `, [chatName, chatIndex, useSearch, options?.chatKey ?? null]));
    };

    if (!targetPoint) {
      targetPoint = await locateTargetPoint(Boolean(options?.useSearch));
    }
    if (!targetPoint && !options?.useSearch && chatName.trim()) {
      targetPoint = await locateTargetPoint(true);
    }

    if (!targetPoint) {
      throw new Error(
        options?.chatKey
          ? `No se encontro el chat con chat_key "${options.chatKey}"${chatName ? ` ni por fallback de busqueda "${chatName}"` : ""}.`
          : `No se encontro el chat "${chatName}".`
      );
    }

    await clickPoint(session, targetPoint.x, targetPoint.y);
  });
  await sleep(1200);
}

export async function openChatBySearch(
  port = DEFAULT_PORT,
  query: string,
  resultIndex = 1
): Promise<void> {
  await runWithWhatsAppUiLock("open_chat_by_search", async () => {
    await openChat(port, query, resultIndex, { useSearch: true });
  });
}

async function locateLatestVoicePlayButton(
  session: CdpSession,
  direction: VoiceNoteDirection = "any",
  voiceNoteIndex = 1
): Promise<{ x: number; y: number } | null> {
  const targetVoiceNoteIndex = Math.max(1, voiceNoteIndex);
  let previousSignature = "";
  let staleAttempts = 0;

  for (let attempt = 0; attempt <= VOICE_NOTE_MAX_SCROLL_STEPS; attempt += 1) {
    const scan = await session.evaluate<{
      point: { x: number; y: number } | null;
      signature: string;
      canScrollMore: boolean;
    }>(js(`
      (direction, voiceNoteIndex) => {
        const main = document.querySelector(${JSON.stringify(conversationRootSelector())});
        if (!(main instanceof HTMLElement)) {
          return { point: null, signature: "missing-main", canScrollMore: false };
        }

        const voiceLabelSources = ${JSON.stringify(voiceNoteLabelPatternSources())};
        const matchesVoiceLabel = (label) => voiceLabelSources
          .some((source) => new RegExp(source, "i").test(String(label || "")));

        const rows = Array.from(main.querySelectorAll("div.message-in, div.message-out"))
          .filter((row) => !row.parentElement?.closest("div.message-in, div.message-out"))
          .filter((row) => {
            if (direction === "in") return row.classList.contains("message-in");
            if (direction === "out") return row.classList.contains("message-out");
            return true;
          });

        const voiceRows = [...rows].filter((row) => Array.from(
          row.querySelectorAll("button[aria-label], [role='button'][aria-label]")
        ).some((node) => matchesVoiceLabel(node.getAttribute("aria-label"))));
        const orderedVoiceRows = [...voiceRows].reverse();
        const targetRow = orderedVoiceRows[Math.max(0, Number(voiceNoteIndex) - 1)] ?? null;

        if (targetRow instanceof HTMLElement) {
          targetRow.scrollIntoView({ block: "center" });
          const target = Array.from(targetRow.querySelectorAll("button[aria-label], [role='button'][aria-label]"))
            .find((node) => matchesVoiceLabel(node.getAttribute("aria-label")));
          if (target instanceof HTMLElement) {
            const rect = target.getBoundingClientRect();
            return {
              point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
              signature: [
                "target",
                rows.length,
                orderedVoiceRows.length,
                targetRow.getAttribute("data-id") || targetRow.getAttribute("data-message-id") || targetRow.textContent?.slice(0, 80) || "",
              ].join("::"),
              canScrollMore: true,
            };
          }
        }

        const anchor = rows[0] ?? main.querySelector("div[role='application'], div[role='grid'], div");
        let scroller = null;
        let cursor = anchor instanceof HTMLElement ? anchor : main;
        while (cursor instanceof HTMLElement) {
          if (cursor.scrollHeight > cursor.clientHeight + 16) {
            scroller = cursor;
            break;
          }
          cursor = cursor.parentElement;
        }
        if (!(scroller instanceof HTMLElement) && main.scrollHeight > main.clientHeight + 16) {
          scroller = main;
        }

        const firstRow = rows[0];
        const lastRow = rows.at(-1);
        const signature = [
          rows.length,
          orderedVoiceRows.length,
          voiceNoteIndex,
          scroller instanceof HTMLElement
            ? [scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight].join(":")
            : "no-scroll",
          firstRow?.getAttribute("data-id") || firstRow?.getAttribute("data-message-id") || firstRow?.textContent?.slice(0, 80) || "",
          lastRow?.getAttribute("data-id") || lastRow?.getAttribute("data-message-id") || lastRow?.textContent?.slice(0, 80) || "",
        ].join("::");

        return {
          point: null,
          signature,
          canScrollMore: Boolean(scroller instanceof HTMLElement && scroller.scrollTop > 0),
        };
      }
    `, [direction, targetVoiceNoteIndex]));

    if (scan.point) {
      return scan.point;
    }

    if (!scan.canScrollMore) {
      return null;
    }

    if (scan.signature === previousSignature) {
      staleAttempts += 1;
      if (staleAttempts >= 2) {
        return null;
      }
    } else {
      previousSignature = scan.signature;
      staleAttempts = 0;
    }

    const advanced = await session.evaluate<boolean>(js(`
      (stepPx) => {
        const main = document.querySelector(${JSON.stringify(conversationRootSelector())});
        if (!(main instanceof HTMLElement)) return false;

        const firstRow = main.querySelector("div.message-in, div.message-out");
        let cursor = firstRow instanceof HTMLElement ? firstRow : main;
        while (cursor instanceof HTMLElement) {
          if (cursor.scrollHeight > cursor.clientHeight + 16) {
            const nextTop = Math.max(0, cursor.scrollTop - Math.max(120, Number(stepPx) || 0));
            const changed = nextTop !== cursor.scrollTop;
            cursor.scrollTop = nextTop;
            return changed;
          }
          cursor = cursor.parentElement;
        }

        return false;
      }
    `, [VOICE_NOTE_SCROLL_STEP_PX]));

    if (!advanced) {
      return null;
    }

    await sleep(VOICE_NOTE_SCROLL_SETTLE_MS);
  }

  return null;
}

export async function listVoiceNotes(
  port = DEFAULT_PORT,
  chatName: string,
  chatIndex?: number,
  direction: VoiceNoteDirection = "any",
  limit = 20,
  options?: { chatKey?: string }
): Promise<VoiceNoteSummary[]> {
  return runWithWhatsAppUiLock("list_voice_notes", async () => {
    await openChat(port, chatName, chatIndex, { chatKey: options?.chatKey });
    const session = await connectWhatsAppSession(port);
    try {
      const collected = new Map<string, VoiceNoteSummary>();
      let previousSignature = "";
      let staleAttempts = 0;

      for (let attempt = 0; attempt <= VOICE_NOTE_MAX_SCROLL_STEPS && collected.size < limit; attempt += 1) {
        const scan = await session.evaluate<{
          notes: Array<Omit<VoiceNoteSummary, "index">>;
          signature: string;
          canScrollMore: boolean;
        }>(js(`
          (direction, limit) => {
            const main = document.querySelector(${JSON.stringify(conversationRootSelector())});
            if (!(main instanceof HTMLElement)) {
              return { notes: [], signature: "missing-main", canScrollMore: false };
            }

            const voiceLabelSources = ${JSON.stringify(voiceNoteLabelPatternSources())};
            const matchesVoiceLabel = (label) => voiceLabelSources
              .some((source) => new RegExp(source, "i").test(String(label || "")));

            const rows = Array.from(main.querySelectorAll("div.message-in, div.message-out"))
              .filter((row) => !row.parentElement?.closest("div.message-in, div.message-out"))
              .filter((row) => {
                if (direction === "in") return row.classList.contains("message-in");
                if (direction === "out") return row.classList.contains("message-out");
                return true;
              });

            const notes = [...rows].reverse()
              .filter((row) => Array.from(row.querySelectorAll("button[aria-label], [role='button'][aria-label]"))
                .some((node) => matchesVoiceLabel(node.getAttribute("aria-label"))))
              .slice(0, limit)
              .map((row, idx) => {
                const metaNode = row.matches("[data-pre-plain-text]")
                  ? row
                  : row.querySelector("[data-pre-plain-text]");
                const meta = metaNode?.getAttribute("data-pre-plain-text") ?? "";
                const durationLabel = Array.from(row.querySelectorAll("[aria-hidden='true'], span, div"))
                  .map((node) => node.textContent?.trim() ?? "")
                  .find((text) => /^\\d{1,2}:\\d{2}$/.test(text)) ?? "";
                const directionLabel = row.classList.contains("message-out") ? "out" : "in";
                const fingerprintSource =
                  row.getAttribute("data-id") ||
                  row.getAttribute("data-message-id") ||
                  row.getAttribute("data-testid") ||
                  [directionLabel, meta, durationLabel, idx + 1].join("::");
                return {
                  direction: directionLabel,
                  durationLabel,
                  meta,
                  fingerprintSource: String(fingerprintSource).trim(),
                };
              });

            const firstRow = rows[0];
            const lastRow = rows.at(-1);
            const anchor = rows[0] ?? main.querySelector("div[role='application'], div[role='grid'], div");
            let scroller = null;
            let cursor = anchor instanceof HTMLElement ? anchor : main;
            while (cursor instanceof HTMLElement) {
              if (cursor.scrollHeight > cursor.clientHeight + 16) {
                scroller = cursor;
                break;
              }
              cursor = cursor.parentElement;
            }
            if (!(scroller instanceof HTMLElement) && main.scrollHeight > main.clientHeight + 16) {
              scroller = main;
            }

            return {
              notes,
              signature: [
                rows.length,
                notes.length,
                scroller instanceof HTMLElement
                  ? [scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight].join(":")
                  : "no-scroll",
                firstRow?.getAttribute("data-id") || firstRow?.getAttribute("data-message-id") || firstRow?.textContent?.slice(0, 80) || "",
                lastRow?.getAttribute("data-id") || lastRow?.getAttribute("data-message-id") || lastRow?.textContent?.slice(0, 80) || "",
              ].join("::"),
              canScrollMore: Boolean(scroller instanceof HTMLElement && scroller.scrollTop > 0),
            };
          }
        `, [direction, limit]));

        for (const note of scan.notes) {
          if (!collected.has(note.fingerprintSource)) {
            collected.set(note.fingerprintSource, {
              index: 0,
              ...note,
            });
          }
        }

        if (!scan.canScrollMore || collected.size >= limit) {
          break;
        }

        if (scan.signature === previousSignature) {
          staleAttempts += 1;
          if (staleAttempts >= 2) break;
        } else {
          previousSignature = scan.signature;
          staleAttempts = 0;
        }

        const advanced = await session.evaluate<boolean>(js(`
          (stepPx) => {
            const main = document.querySelector(${JSON.stringify(conversationRootSelector())});
            if (!(main instanceof HTMLElement)) return false;
            const firstRow = main.querySelector("div.message-in, div.message-out");
            let cursor = firstRow instanceof HTMLElement ? firstRow : main;
            while (cursor instanceof HTMLElement) {
              if (cursor.scrollHeight > cursor.clientHeight + 16) {
                const nextTop = Math.max(0, cursor.scrollTop - Math.max(120, Number(stepPx) || 0));
                const changed = nextTop !== cursor.scrollTop;
                cursor.scrollTop = nextTop;
                return changed;
              }
              cursor = cursor.parentElement;
            }
            return false;
          }
        `, [VOICE_NOTE_SCROLL_STEP_PX]));

        if (!advanced) break;
        await sleep(VOICE_NOTE_SCROLL_SETTLE_MS);
      }

      return [...collected.values()]
        .slice(0, limit)
        .map((note, index) => ({
          ...note,
          index: index + 1,
        }));
    } finally {
      await session.close();
    }
  });
}

export async function downloadLatestVoiceNote(
  port = DEFAULT_PORT,
  chatName: string,
  chatIndex?: number,
  direction: VoiceNoteDirection = "any",
  options?: { chatKey?: string; voiceNoteIndex?: number }
): Promise<DownloadedVoiceNote> {
  return runWithWhatsAppUiLock("download_latest_voice_note", async () => {
    await openChat(port, chatName, chatIndex, { chatKey: options?.chatKey });
    mkdirSync(DOWNLOADS_DIR, { recursive: true });
    maintainTmpDir(DOWNLOADS_DIR);

    const session = await connectWhatsAppSession(port);
    const networkEvents: CapturedAudioEvent[] = [];
    const unsubscribe = session.on("Network.responseReceived", (raw) => {
      const params = raw as {
        requestId: string;
        type?: string;
        response?: { url?: string; mimeType?: string };
      };
      const url = params.response?.url ?? "";
      const mimeType = params.response?.mimeType ?? "";
      const type = params.type ?? "";
      if (/audio|ogg|opus|mpeg|mp3/i.test(`${url} ${mimeType} ${type}`)) {
        networkEvents.push({ requestId: params.requestId, url, mimeType, type });
      }
    });

    try {
      await session.send("Network.enable");
      const playPoint = await locateLatestVoicePlayButton(session, direction, options?.voiceNoteIndex);
      if (!playPoint) {
        const requestedVoiceNote = Math.max(1, options?.voiceNoteIndex ?? 1);
        throw new Error(`No se encontro la nota de voz #${requestedVoiceNote} en el historial cargado del chat "${chatName}" tras recorrer mensajes anteriores.`);
      }

      await clickPoint(session, playPoint.x, playPoint.y);
      await sleep(2500);

      const audioEvent = selectBestAudioEvent(networkEvents);
      if (!audioEvent?.url) {
        throw new Error(`No se pudo capturar la URL del audio para el chat "${chatName}"`);
      }

      const payload = await session.evaluate<{ base64: string; mimeType: string }>(js(`
        async (blobUrl) => {
          const response = await fetch(blobUrl);
          const arrayBuffer = await response.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          return {
            base64: btoa(binary),
            mimeType: response.headers.get("content-type") || "audio/ogg"
          };
        }
      `, [audioEvent.url]));

      const ext = payload.mimeType.includes("ogg")
        ? "ogg"
        : payload.mimeType.includes("opus")
          ? "opus"
          : payload.mimeType.includes("mpeg") || payload.mimeType.includes("mp3")
            ? "mp3"
            : "bin";
      const safeName = chatName.replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "") || "chat";
      const filePath = path.join(DOWNLOADS_DIR, `${safeName}-${Date.now()}.${ext}`);
      writeFileSync(filePath, Buffer.from(payload.base64, "base64"));

      return {
        path: filePath,
        mimeType: payload.mimeType,
        blobUrl: audioEvent.url,
        chatName,
      };
    } finally {
      unsubscribe();
      await session.close();
    }
  });
}

export async function listImageMessages(
  port = DEFAULT_PORT,
  chatName: string,
  chatIndex?: number,
  direction: "in" | "out" | "any" = "any",
  limit = 20,
  options?: { chatKey?: string }
): Promise<ImageSummary[]> {
  return runWithWhatsAppUiLock("list_image_messages", async () => {
    await openChat(port, chatName, chatIndex, { chatKey: options?.chatKey });
    const session = await connectWhatsAppSession(port);
    try {
      const collected = new Map<string, ImageSummary>();
      let previousSignature = "";
      let staleAttempts = 0;

      for (let attempt = 0; attempt <= IMAGE_MAX_SCROLL_STEPS && collected.size < limit; attempt += 1) {
        const scan = await session.evaluate<{
          images: Array<Omit<ImageSummary, "index">>;
          signature: string;
          canScrollMore: boolean;
        }>(js(`
          (direction, limit) => {
            const { rowHasRealImage } = (${imageDetectionHelpersSource()})();
            const main = document.querySelector(${JSON.stringify(conversationRootSelector())});
            if (!(main instanceof HTMLElement)) {
              return { images: [], signature: "missing-main", canScrollMore: false };
            }

            const rows = Array.from(main.querySelectorAll("div.message-in, div.message-out"))
              .filter((row) => !row.parentElement?.closest("div.message-in, div.message-out"))
              .filter((row) => {
                if (direction === "in") return row.classList.contains("message-in");
                if (direction === "out") return row.classList.contains("message-out");
                return true;
              });

            const images = [...rows].reverse()
              .filter((row) => rowHasRealImage(row))
              .slice(0, limit)
              .map((row, idx) => {
                const metaNode = row.matches("[data-pre-plain-text]") ? row : row.querySelector("[data-pre-plain-text]");
                const meta = metaNode?.getAttribute("data-pre-plain-text") ?? "";
                const caption = Array.from(row.querySelectorAll("span.copyable-text, p.copyable-text"))
                  .map((node) => node.textContent?.trim() ?? "")
                  .filter(Boolean)
                  .join("\\n");
                const directionLabel = row.classList.contains("message-out") ? "out" : "in";
                const fingerprintSource =
                  row.getAttribute("data-id") ||
                  row.getAttribute("data-message-id") ||
                  row.getAttribute("data-testid") ||
                  [directionLabel, meta, caption || "[Imagen]", idx + 1].join("::");
                return {
                  direction: directionLabel,
                  caption,
                  meta,
                  fingerprintSource: String(fingerprintSource).trim(),
                };
              });

            const firstRow = rows[0];
            const lastRow = rows.at(-1);
            const anchor = rows[0] ?? main.querySelector("div[role='application'], div[role='grid'], div");
            let scroller = null;
            let cursor = anchor instanceof HTMLElement ? anchor : main;
            while (cursor instanceof HTMLElement) {
              if (cursor.scrollHeight > cursor.clientHeight + 16) {
                scroller = cursor;
                break;
              }
              cursor = cursor.parentElement;
            }
            if (!(scroller instanceof HTMLElement) && main.scrollHeight > main.clientHeight + 16) {
              scroller = main;
            }

            return {
              images,
              signature: [
                rows.length,
                images.length,
                scroller instanceof HTMLElement
                  ? [scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight].join(":")
                  : "no-scroll",
                firstRow?.getAttribute("data-id") || firstRow?.getAttribute("data-message-id") || firstRow?.textContent?.slice(0, 80) || "",
                lastRow?.getAttribute("data-id") || lastRow?.getAttribute("data-message-id") || lastRow?.textContent?.slice(0, 80) || "",
              ].join("::"),
              canScrollMore: Boolean(scroller instanceof HTMLElement && scroller.scrollTop > 0),
            };
          }
        `, [direction, limit]));

        for (const image of scan.images) {
          if (!collected.has(image.fingerprintSource)) {
            collected.set(image.fingerprintSource, {
              index: 0,
              ...image,
            });
          }
        }

        if (!scan.canScrollMore || collected.size >= limit) {
          break;
        }

        if (scan.signature === previousSignature) {
          staleAttempts += 1;
          if (staleAttempts >= 2) break;
        } else {
          previousSignature = scan.signature;
          staleAttempts = 0;
        }

        const advanced = await session.evaluate<boolean>(js(`
          (stepPx) => {
            const main = document.querySelector(${JSON.stringify(conversationRootSelector())});
            if (!(main instanceof HTMLElement)) return false;
            const firstRow = main.querySelector("div.message-in, div.message-out");
            let cursor = firstRow instanceof HTMLElement ? firstRow : main;
            while (cursor instanceof HTMLElement) {
              if (cursor.scrollHeight > cursor.clientHeight + 16) {
                const nextTop = Math.max(0, cursor.scrollTop - Math.max(120, Number(stepPx) || 0));
                const changed = nextTop !== cursor.scrollTop;
                cursor.scrollTop = nextTop;
                return changed;
              }
              cursor = cursor.parentElement;
            }
            return false;
          }
        `, [IMAGE_SCROLL_STEP_PX]));

        if (!advanced) break;
        await sleep(IMAGE_SCROLL_SETTLE_MS);
      }

      return [...collected.values()]
        .slice(0, limit)
        .map((image, index) => ({
          ...image,
          index: index + 1,
        }));
    } finally {
      await session.close();
    }
  });
}

export async function downloadImageMessage(
  port = DEFAULT_PORT,
  chatName: string,
  chatIndex?: number,
  direction: "in" | "out" | "any" = "any",
  options?: { chatKey?: string; imageIndex?: number }
): Promise<DownloadedImage> {
  return runWithWhatsAppUiLock("download_image_message", async () => {
    await openChat(port, chatName, chatIndex, { chatKey: options?.chatKey });
    mkdirSync(DOWNLOADS_DIR, { recursive: true });
    maintainTmpDir(DOWNLOADS_DIR);
    const session = await connectWhatsAppSession(port);
    try {
      const requestedImage = Math.max(1, options?.imageIndex ?? 1);
      let previousSignature = "";
      let staleAttempts = 0;

      for (let attempt = 0; attempt <= IMAGE_MAX_SCROLL_STEPS; attempt += 1) {
        const scan = await session.evaluate<{
          payload: { base64: string; mimeType: string; sourceUrl: string; caption: string } | null;
          signature: string;
          canScrollMore: boolean;
        }>(js(`
          async (direction, imageIndex) => {
            const { getMessageImageCandidates, rowHasRealImage } = (${imageDetectionHelpersSource()})();
            const main = document.querySelector(${JSON.stringify(conversationRootSelector())});
            if (!(main instanceof HTMLElement)) {
              return { payload: null, signature: "missing-main", canScrollMore: false };
            }

            const rows = Array.from(main.querySelectorAll("div.message-in, div.message-out"))
              .filter((row) => !row.parentElement?.closest("div.message-in, div.message-out"))
              .filter((row) => {
                if (direction === "in") return row.classList.contains("message-in");
                if (direction === "out") return row.classList.contains("message-out");
                return true;
              });

            const imageRows = [...rows].reverse().filter((row) => rowHasRealImage(row));
            const targetRow = imageRows[Math.max(0, Number(imageIndex) - 1)] ?? null;

            if (targetRow instanceof HTMLElement) {
              targetRow.scrollIntoView({ block: "center" });
              await new Promise((resolve) => setTimeout(resolve, 300));

              const images = getMessageImageCandidates(targetRow);
              const targetImage = images
                .sort((a, b) => ((b.naturalWidth || b.width || 0) * (b.naturalHeight || b.height || 0)) - ((a.naturalWidth || a.width || 0) * (a.naturalHeight || a.height || 0)))[0];

              if (targetImage instanceof HTMLImageElement) {
                const sourceUrl = targetImage.currentSrc || targetImage.src || targetImage.getAttribute("src") || "";
                if (sourceUrl) {
                  const response = await fetch(sourceUrl);
                  const arrayBuffer = await response.arrayBuffer();
                  const bytes = new Uint8Array(arrayBuffer);
                  let binary = "";
                  for (const byte of bytes) binary += String.fromCharCode(byte);

                  const caption = Array.from(targetRow.querySelectorAll("span.copyable-text, p.copyable-text"))
                    .map((node) => node.textContent?.trim() ?? "")
                    .filter(Boolean)
                    .join("\\n");

                  return {
                    payload: {
                      base64: btoa(binary),
                      mimeType: response.headers.get("content-type") || "image/jpeg",
                      sourceUrl,
                      caption,
                    },
                    signature: ["target", rows.length, imageRows.length, imageIndex].join("::"),
                    canScrollMore: true,
                  };
                }
              }
            }

            const firstRow = rows[0];
            const lastRow = rows.at(-1);
            const anchor = rows[0] ?? main.querySelector("div[role='application'], div[role='grid'], div");
            let scroller = null;
            let cursor = anchor instanceof HTMLElement ? anchor : main;
            while (cursor instanceof HTMLElement) {
              if (cursor.scrollHeight > cursor.clientHeight + 16) {
                scroller = cursor;
                break;
              }
              cursor = cursor.parentElement;
            }
            if (!(scroller instanceof HTMLElement) && main.scrollHeight > main.clientHeight + 16) {
              scroller = main;
            }

            return {
              payload: null,
              signature: [
                rows.length,
                imageRows.length,
                imageIndex,
                scroller instanceof HTMLElement
                  ? [scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight].join(":")
                  : "no-scroll",
                firstRow?.getAttribute("data-id") || firstRow?.getAttribute("data-message-id") || firstRow?.textContent?.slice(0, 80) || "",
                lastRow?.getAttribute("data-id") || lastRow?.getAttribute("data-message-id") || lastRow?.textContent?.slice(0, 80) || "",
              ].join("::"),
              canScrollMore: Boolean(scroller instanceof HTMLElement && scroller.scrollTop > 0),
            };
          }
        `, [direction, requestedImage]));

        if (scan.payload) {
          const ext = imageExtensionFromMimeType(scan.payload.mimeType);
          const safeName = chatName.replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "") || "chat";
          const filePath = path.join(DOWNLOADS_DIR, `${safeName}-image-${Date.now()}.${ext}`);
          writeFileSync(filePath, Buffer.from(scan.payload.base64, "base64"));

          return {
            path: filePath,
            mimeType: scan.payload.mimeType,
            sourceUrl: scan.payload.sourceUrl,
            chatName,
            caption: scan.payload.caption,
          };
        }

        if (!scan.canScrollMore) {
          break;
        }

        if (scan.signature === previousSignature) {
          staleAttempts += 1;
          if (staleAttempts >= 2) break;
        } else {
          previousSignature = scan.signature;
          staleAttempts = 0;
        }

        const advanced = await session.evaluate<boolean>(js(`
          (stepPx) => {
            const main = document.querySelector(${JSON.stringify(conversationRootSelector())});
            if (!(main instanceof HTMLElement)) return false;
            const firstRow = main.querySelector("div.message-in, div.message-out");
            let cursor = firstRow instanceof HTMLElement ? firstRow : main;
            while (cursor instanceof HTMLElement) {
              if (cursor.scrollHeight > cursor.clientHeight + 16) {
                const nextTop = Math.max(0, cursor.scrollTop - Math.max(120, Number(stepPx) || 0));
                const changed = nextTop !== cursor.scrollTop;
                cursor.scrollTop = nextTop;
                return changed;
              }
              cursor = cursor.parentElement;
            }
            return false;
          }
        `, [IMAGE_SCROLL_STEP_PX]));

        if (!advanced) break;
        await sleep(IMAGE_SCROLL_SETTLE_MS);
      }

      throw new Error(`No se encontro la imagen #${requestedImage} en el historial cargado del chat "${chatName}" tras recorrer mensajes anteriores.`);
    } finally {
      await session.close();
    }
  });
}

export async function readMessages(
  port = DEFAULT_PORT,
  chatName: string,
  limit = 20,
  chatIndex?: number,
  options?: { chatKey?: string }
): Promise<ChatMessage[]> {
  return runWithWhatsAppUiLock("read_chat_messages", async () => {
    await openChat(port, chatName, chatIndex, { chatKey: options?.chatKey });
    return withWhatsAppSession(port, async (session) => {
      return session.evaluate<ChatMessage[]>(js(`
      (limit) => {
        const { rowHasRealImage } = (${imageDetectionHelpersSource()})();
        const main = document.querySelector(${JSON.stringify(conversationRootSelector())});
        if (!main) return [];

        const rows = Array.from(main.querySelectorAll("div.message-in, div.message-out"))
          .filter((row) => !row.parentElement?.closest("div.message-in, div.message-out"));
        const messages = rows.map((row, idx) => {
          const metaNode = row.matches("[data-pre-plain-text]")
            ? row
            : row.querySelector("[data-pre-plain-text]");
          const text = Array.from(
            row.querySelectorAll("span.copyable-text, p.copyable-text, img[alt]")
          )
            .map((node) => {
              if (node instanceof HTMLImageElement) return node.alt?.trim() ?? "";
              return node.textContent?.trim() ?? "";
            })
            .filter(Boolean)
            .join("\\n");
          const hasImage = rowHasRealImage(row);
          const hasVoiceNote = Boolean(
            Array.from(row.querySelectorAll("button[aria-label], [role='button'][aria-label]")).find((node) => {
              const label = node.getAttribute("aria-label") ?? "";
              return ${JSON.stringify(voiceNoteLabelPatternSources())}.some((source) => new RegExp(source, "i").test(label));
            })
          );
          const meta = metaNode?.getAttribute("data-pre-plain-text") ?? "";
          const direction = row.classList.contains("message-out")
            ? "out"
            : row.classList.contains("message-in")
              ? "in"
              : "unknown";
          const fingerprintSource =
            row.getAttribute("data-id") ||
            row.getAttribute("data-message-id") ||
            row.getAttribute("data-testid") ||
            \`\${idx + 1}::\${meta}::\${text || (hasVoiceNote ? "[Nota de voz]" : "")}::\${direction}\`;
          return {
            index: idx + 1,
            direction,
            text: text || (hasVoiceNote ? "[Nota de voz]" : hasImage ? "[Imagen]" : ""),
            meta,
            fingerprintSource,
            mediaKind: hasVoiceNote ? "voice_note" : hasImage ? "image" : undefined,
          };
        }).filter((message) => message.text);

        return messages.slice(-limit);
      }
    `, [limit]));
    });
  });
}

export async function sendMessage(
  port = DEFAULT_PORT,
  chatName: string,
  text: string,
  chatIndex?: number,
  options?: { chatKey?: string }
): Promise<void> {
  await runWithWhatsAppUiLock("send_message", async () => {
    await openChat(port, chatName, chatIndex, { chatKey: options?.chatKey });
    await withWhatsAppSession(port, async (session) => {
      const sendPoint = await session.evaluate<{ x: number; y: number } | null>(js(`
      (text) => {
        const composer =
          document.querySelector("footer div[contenteditable='true'][data-tab]") ||
          document.querySelector("${conversationRootSelector()} div[contenteditable='true'][role='textbox']");
        if (!(composer instanceof HTMLElement)) return null;

        composer.focus();
        composer.textContent = "";

        const selection = window.getSelection();
        if (!selection) return null;
        selection.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(true);

        const textNode = document.createTextNode(text);
        composer.appendChild(textNode);

        range.setStartAfter(textNode);
        range.collapse(true);
        selection.addRange(range);

        composer.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));

        const sendButton =
          document.querySelector("[data-icon='send']")?.closest("button, span, div") ||
          document.querySelector("button[aria-label='Send']") ||
          document.querySelector("button[aria-label='Enviar']");

        if (sendButton instanceof HTMLElement) {
          const rect = sendButton.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
          };
        }

        return null;
      }
    `, [text]));

      if (sendPoint) {
        await clickPoint(session, sendPoint.x, sendPoint.y);
        return;
      }

      const composerFocused = await session.evaluate<boolean>(js(`
        () => {
          const composer =
            document.querySelector("footer div[contenteditable='true'][data-tab]") ||
            document.querySelector("${conversationRootSelector()} div[contenteditable='true'][role='textbox']");
          if (!(composer instanceof HTMLElement)) return false;
          composer.focus();
          return document.activeElement === composer;
        }
      `));

      if (!composerFocused) {
        throw new Error(`No se pudo enviar mensaje al chat "${chatName}"`);
      }

      await pressKey(session, "Enter", { code: "Enter" });
    });
  });
}

export async function waitForWhatsAppReady(port = DEFAULT_PORT, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const auth = await checkAuth(port);
    if (auth.ok) return;
    await sleep(1500);
  }
  throw new Error("WhatsApp Web no quedo listo a tiempo");
}

async function installActivityObserver(session: CdpSession): Promise<void> {
  await session.send("Runtime.addBinding", { name: "__waMcpNotify" });
  await session.evaluate<string>(js(`
    () => {
      const globalKey = "__waMcpWatcherInstalled";
      if (window[globalKey]) return "already-installed";

      const topLevelRows = (root) => Array.from(
        root.querySelectorAll("div[role='listitem'], div[role='gridcell']")
      ).filter((row) => !row.parentElement?.closest("div[role='listitem'], div[role='gridcell']"));

      const readChatRows = () => {
        const pane = document.querySelector(${JSON.stringify(paneSelector())});
        if (!pane) return [];
        return topLevelRows(pane).map((row) => {
          const titleNode =
            row.querySelector("span[title]") ||
            row.querySelector("img[alt]") ||
            row.querySelector("[dir='auto']");
          const title =
            titleNode?.getAttribute?.("title") ||
            titleNode?.getAttribute?.("alt") ||
            titleNode?.textContent ||
            "";

          const previewNode = Array.from(row.querySelectorAll("span"))
            .map((node) => node.textContent?.trim() ?? "")
            .filter(Boolean)
            .find((text) => text !== title);

          const unreadNode =
            row.querySelector("[aria-label*='unread']") ||
            row.querySelector("[data-testid='icon-unread-count']") ||
            Array.from(row.querySelectorAll("span")).find((span) => /^\\d+$/.test(span.textContent?.trim() ?? ""));

          const unreadText = unreadNode?.textContent?.trim() ?? "";
          const unreadCount = /^\\d+$/.test(unreadText) ? Number(unreadText) : 0;
          const rowIndex = Array.from(row.parentElement?.children ?? []).indexOf(row) + 1;
          const chatKey =
            ${chatKeyPartsExpression()} ||
            ${chatKeyFallbackExpression("title", "rowIndex")};

          return {
            chatKey: String(chatKey).trim(),
            title: title.trim(),
            unreadCount,
            preview: (previewNode ?? "").trim(),
          };
        }).filter((row) => row.title);
      };

      const getLatestIncoming = () => {
        const main = document.querySelector(${JSON.stringify(conversationRootSelector())});
        if (!main) return null;
        const rows = Array.from(main.querySelectorAll("div.message-in, div[data-pre-plain-text]"));
        const last = rows.at(-1);
        if (!last) return null;
        const hasVoiceNote = Boolean(
          Array.from(last.querySelectorAll("button[aria-label], [role='button'][aria-label]")).find((node) => {
            const label = node.getAttribute("aria-label") ?? "";
            return ${JSON.stringify(voiceNoteLabelPatternSources())}.some((source) => new RegExp(source, "i").test(label));
          })
        );
        const text = Array.from(last.querySelectorAll("span.selectable-text, div.copyable-text span"))
          .map((node) => node.textContent?.trim() ?? "")
          .filter(Boolean)
          .join("\\n")
          .trim();
        if (!text && !hasVoiceNote) return null;

        const header = document.querySelector("${conversationRootSelector()} header span[title], ${conversationRootSelector()} header img[alt]");
        const chatName =
          header?.getAttribute?.("title") ||
          header?.getAttribute?.("alt") ||
          header?.textContent ||
          "";
        const selectedChat = Array.from(document.querySelectorAll("#pane-side div[role='listitem'], #pane-side div[role='gridcell']"))
          .find((row) => row.getAttribute("aria-selected") === "true");
        const selectedTitleNode =
          selectedChat?.querySelector("span[title]") ||
          selectedChat?.querySelector("img[alt]") ||
          selectedChat?.querySelector("[dir='auto']");
        const selectedTitle =
          selectedTitleNode?.getAttribute?.("title") ||
          selectedTitleNode?.getAttribute?.("alt") ||
          selectedTitleNode?.textContent ||
          chatName;
        const selectedRowIndex = selectedChat && selectedChat.parentElement
          ? Array.from(selectedChat.parentElement.children).indexOf(selectedChat) + 1
          : 1;
        const chatKey =
          ${chatKeyPartsExpression("selectedChat")} ||
          ${chatKeyFallbackExpression("selectedTitle", "selectedRowIndex")};

        return {
          type: "incoming-message",
          chatName: chatName.trim(),
          chatKey: String(chatKey).trim(),
          unreadCount: 0,
          preview: hasVoiceNote ? "[Nota de voz]" : text.slice(0, 200),
          timestamp: Date.now(),
        };
      };

      let lastUnreadSignature = JSON.stringify(readChatRows().filter((row) => row.unreadCount > 0));
      let lastIncomingSignature = "";

      const emit = (payload) => {
        if (typeof window.__waMcpNotify === "function") {
          window.__waMcpNotify(JSON.stringify(payload));
        }
      };

      const notifyUnreadChanges = () => {
        const unreadRows = readChatRows().filter((row) => row.unreadCount > 0);
        const signature = JSON.stringify(unreadRows);
        if (signature === lastUnreadSignature) return;
        lastUnreadSignature = signature;
        unreadRows.forEach((row) => {
          emit({
            type: "unread-chat",
            chatName: row.title,
            chatKey: row.chatKey,
            unreadCount: row.unreadCount,
            preview: row.preview,
            timestamp: Date.now(),
          });
        });
      };

      const notifyIncomingMessage = () => {
        const payload = getLatestIncoming();
        if (!payload) return;
        const signature = JSON.stringify(payload);
        if (signature === lastIncomingSignature) return;
        lastIncomingSignature = signature;
        emit(payload);
      };

      const installObserver = (target, callback) => {
        if (!target) return;
        const observer = new MutationObserver(() => callback());
        observer.observe(target, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        window.__waMcpObservers = window.__waMcpObservers || [];
        window.__waMcpObservers.push(observer);
      };

      installObserver(document.querySelector("#pane-side"), notifyUnreadChanges);
      installObserver(document.querySelector(${JSON.stringify(conversationRootSelector())}), notifyIncomingMessage);

      window[globalKey] = true;
      return "installed";
    }
  `));
}

export async function waitForActivityEvent(
  port = DEFAULT_PORT,
  timeoutMs = 300000
): Promise<ChatActivityEvent | null> {
  const session = await connectWhatsAppSession(port);
  try {
    await installActivityObserver(session);
    const event = await session.waitForEvent<{ name: string; payload: string }>(
      "Runtime.bindingCalled",
      (params) => params.name === "__waMcpNotify",
      timeoutMs
    );
    return JSON.parse(event.payload) as ChatActivityEvent;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Timeout esperando evento CDP")) {
      return null;
    }
    throw error;
  } finally {
    await session.close();
  }
}
