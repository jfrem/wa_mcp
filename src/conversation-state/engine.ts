import type { ConversationSignal, ConversationState, ConversationStateInput, ConversationStateMessage } from "./types.js";

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isEmojiOnly(value: string): boolean {
  return /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\u200D\uFE0F\s]+$/u.test(value);
}

export function normalizeConversationText(value: string): string {
  const cleanedLines = value
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean)
    .filter((line) => !/^(foto|video|imagen)$/i.test(line))
    .filter((line) => !isEmojiOnly(line));

  return cleanText(cleanedLines.join(" "));
}

export function parseConversationMetaDate(meta?: string): Date | null {
  if (!meta) return null;
  const match = meta.match(/\[(\d{1,2}):(\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\]/);
  if (!match) return null;

  let year = Number(match[5]);
  if (year < 100) year += 2000;
  const parsed = new Date(year, Number(match[4]) - 1, Number(match[3]), Number(match[1]), Number(match[2]), 0, 0);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function computeConversationIdleMinutes(message: ConversationStateMessage | null, now: number): number | null {
  const parsed = parseConversationMetaDate(message?.meta);
  if (!parsed) return null;
  const diffMs = now - parsed.getTime();
  if (diffMs < 0) return 0;
  return Math.round(diffMs / 60000);
}

export function isMeaningfulConversationMessage(message: ConversationStateMessage): boolean {
  const normalized = normalizeConversationText(message.text);
  return Boolean(normalized) && normalized !== "[Imagen]" && normalized !== "[Nota de voz]";
}

export function isRelevantConversationMessage(message: ConversationStateMessage): boolean {
  return isMeaningfulConversationMessage(message) || message.mediaKind === "image" || message.mediaKind === "voice_note";
}

export function extractRelevantConversationText(message: ConversationStateMessage | null): string | null {
  if (!message) return null;
  const normalized = normalizeConversationText(message.text);
  if (normalized && normalized !== "[Imagen]" && normalized !== "[Nota de voz]") {
    return normalized;
  }
  if (message.mediaKind === "image") return "[Imagen]";
  if (message.mediaKind === "voice_note") return "[Nota de voz]";
  return null;
}

export function findLastRelevantConversationMessage(messages: ConversationStateMessage[]): ConversationStateMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRelevantConversationMessage(message)) return message;
  }
  return null;
}

export function findLastRelevantConversationMessageByDirection(
  messages: ConversationStateMessage[],
  direction: "in" | "out",
): ConversationStateMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.direction === direction && isRelevantConversationMessage(message)) return message;
  }
  return null;
}

function containsQuestionSignal(value: string): boolean {
  const normalized = normalizeConversationText(value).toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("?")) return true;
  return /\b(que|qué|como|cómo|cuando|cuándo|donde|dónde|cuál|cual|por que|por qué|todavia|todavía|disponible|me ayudas)\b/i.test(normalized);
}

function containsPromiseSignal(value: string): boolean {
  const normalized = normalizeConversationText(value).toLowerCase();
  if (!normalized) return false;
  return /\b(te (envio|mando|paso|comparto|confirmo|aviso|digo)|ya te (envio|mando|paso|comparto|confirmo|aviso|digo)|ahora te (envio|mando|paso|comparto|confirmo|aviso|digo))\b/i.test(normalized);
}

function classifyWaitingOn(lastRelevant: ConversationStateMessage | null): ConversationState["waitingOn"] {
  if (!lastRelevant) return "unknown";
  if (lastRelevant.direction === "in") return "us";
  if (lastRelevant.direction === "out") return "them";
  return "unknown";
}

function findLastOutboundRelevantIndex(messages: ConversationStateMessage[], targetIndex: number): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.direction === "out" && message.index === targetIndex) {
      return index;
    }
  }
  return -1;
}

function computeConfidence(signals: ConversationSignal[], idleMinutes: number | null, staleAfterMinutes: number): number {
  let score = 0.45;
  score += Math.min(0.25, signals.length * 0.08);
  if ((idleMinutes ?? 0) >= staleAfterMinutes) score += 0.15;
  if ((idleMinutes ?? 0) >= staleAfterMinutes * 2) score += 0.05;
  return Math.max(0.05, Math.min(0.99, Number(score.toFixed(2))));
}

function buildSummary(state: {
  chatName: string;
  waitingOn: ConversationState["waitingOn"];
  idleMinutes: number | null;
  lastRelevantText: string | null;
  signals: ConversationSignal[];
}): string {
  const parts = [`Chat "${state.chatName}"`];
  if (state.lastRelevantText) {
    parts.push(`ultimo contexto relevante: "${state.lastRelevantText}".`);
  } else {
    parts.push("sin contexto relevante suficiente.");
  }
  if (state.waitingOn === "us") {
    parts.push("El siguiente paso parece estar del lado del negocio.");
  } else if (state.waitingOn === "them") {
    parts.push("El siguiente paso parece estar del lado del cliente.");
  }
  if (typeof state.idleMinutes === "number") {
    parts.push(`Idle: ${state.idleMinutes} minuto(s).`);
  }
  if (state.signals.length) {
    parts.push(`Signals: ${state.signals.map((signal) => signal.type).join(", ")}.`);
  }
  return parts.join(" ");
}

export function buildConversationState(input: ConversationStateInput): ConversationState {
  const now = input.now ?? Date.now();
  const lastRelevantMessage = findLastRelevantConversationMessage(input.messages);
  const lastInboundMessage = findLastRelevantConversationMessageByDirection(input.messages, "in");
  const lastOutboundMessage = findLastRelevantConversationMessageByDirection(input.messages, "out");
  const waitingOn = classifyWaitingOn(lastRelevantMessage);
  const idleMinutes = computeConversationIdleMinutes(lastRelevantMessage, now);
  const signals: ConversationSignal[] = [];

  if (input.unreadCount > 0) {
    signals.push({
      type: "has_unread",
      score: 0.2,
      evidence: `Hay ${input.unreadCount} mensaje(s) no leidos visibles.`,
    });
  }

  if (lastInboundMessage && containsQuestionSignal(lastInboundMessage.text) && waitingOn === "us") {
    signals.push(
      {
        type: "customer_question",
        score: 0.8,
        evidence: `El ultimo mensaje entrante relevante contiene una pregunta: "${normalizeConversationText(lastInboundMessage.text)}".`,
      },
      {
        type: "open_question",
        score: 0.85,
        evidence: "La pregunta abierta sigue esperando respuesta del negocio.",
      },
    );
  }

  if (lastOutboundMessage && containsPromiseSignal(lastOutboundMessage.text)) {
    const lastOutgoingIndex = findLastOutboundRelevantIndex(input.messages, lastOutboundMessage.index);
    const laterRelevantOutbound = input.messages
      .slice(lastOutgoingIndex + 1)
      .some((message) => message.direction === "out" && isRelevantConversationMessage(message));
    if (!laterRelevantOutbound) {
      signals.push(
        {
          type: "business_promise",
          score: 0.7,
          evidence: `El ultimo mensaje saliente contiene una promesa: "${normalizeConversationText(lastOutboundMessage.text)}".`,
        },
        {
          type: "unresolved_promise",
          score: 0.9,
          evidence: "No se detecto una salida posterior que cumpla la promesa comercial/operativa.",
        },
      );
    }
  }

  if (waitingOn === "us") {
    signals.push({
      type: "awaiting_business_response",
      score: 0.7,
      evidence: "El ultimo mensaje relevante fue entrante.",
    });
    if ((idleMinutes ?? 0) >= input.staleAfterMinutes) {
      signals.push({
        type: "follow_up_needed",
        score: 0.82,
        evidence: `Han pasado ${idleMinutes ?? 0} minuto(s) sin respuesta del negocio.`,
      });
    }
  } else if (waitingOn === "them") {
    signals.push({
      type: "awaiting_customer_response",
      score: 0.55,
      evidence: "El ultimo mensaje relevante fue saliente.",
    });
  }

  if ((idleMinutes ?? 0) >= input.staleAfterMinutes) {
    signals.push({
      type: "conversation_idle",
      score: 0.6,
      evidence: `La conversacion lleva ${idleMinutes ?? 0} minuto(s) sin avance relevante.`,
    });
  }

  const lastRelevantText = extractRelevantConversationText(lastRelevantMessage);
  const confidence = computeConfidence(signals, idleMinutes, input.staleAfterMinutes);

  return {
    chatName: input.chatName,
    chatKey: input.chatKey ?? null,
    unreadCount: input.unreadCount,
    messages: input.messages,
    staleAfterMinutes: input.staleAfterMinutes,
    lastRelevantMessage,
    lastInboundMessage,
    lastOutboundMessage,
    lastRelevantText,
    waitingOn,
    idleMinutes,
    confidence,
    signals,
    summary: buildSummary({
      chatName: input.chatName,
      waitingOn,
      idleMinutes,
      lastRelevantText,
      signals,
    }),
  };
}
