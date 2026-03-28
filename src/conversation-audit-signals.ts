import type {
  AuditConversationItem,
  AuditConversationMessage,
  AuditPriority,
  AuditStallType,
  AuditStatus,
  AuditWaitingOn,
} from "./conversation-audit-types.js";

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isEmojiOnly(value: string): boolean {
  return /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\u200D\uFE0F\s]+$/u.test(value);
}

function normalizeMessageText(value: string): string {
  const cleanedLines = value
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean)
    .filter((line) => !/^(foto|video|imagen)$/i.test(line))
    .filter((line) => !isEmojiOnly(line));

  return cleanText(cleanedLines.join(" "));
}

function truncate(value: string, maxLength = 140): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(1, maxLength - 1)).trim()}...`;
}

function isMeaningfulText(message: AuditConversationMessage): boolean {
  const normalized = normalizeMessageText(message.text);
  return Boolean(normalized) && normalized !== "[Imagen]" && normalized !== "[Nota de voz]";
}

function isRelevantMessage(message: AuditConversationMessage): boolean {
  return isMeaningfulText(message) || message.mediaKind === "image" || message.mediaKind === "voice_note";
}

function extractRelevantText(message: AuditConversationMessage | null): string | null {
  if (!message) return null;
  const normalized = normalizeMessageText(message.text);
  if (normalized && normalized !== "[Imagen]" && normalized !== "[Nota de voz]") {
    return truncate(normalized);
  }
  if (message.mediaKind === "image") return "[Imagen]";
  if (message.mediaKind === "voice_note") return "[Nota de voz]";
  return null;
}

function parseMetaDate(meta?: string): Date | null {
  if (!meta) return null;
  const match = meta.match(/\[(\d{1,2}):(\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\]/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const day = Number(match[3]);
  const month = Number(match[4]);
  let year = Number(match[5]);
  if (year < 100) year += 2000;
  const parsed = new Date(year, month - 1, day, hour, minute, 0, 0);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function computeIdleMinutes(message: AuditConversationMessage | null): number | null {
  const parsed = parseMetaDate(message?.meta);
  if (!parsed) return null;
  const diffMs = Date.now() - parsed.getTime();
  if (diffMs < 0) return 0;
  return Math.round(diffMs / 60000);
}

function findLastRelevantMessage(messages: AuditConversationMessage[]): AuditConversationMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRelevantMessage(message)) return message;
  }
  return null;
}

function findLastRelevantByDirection(
  messages: AuditConversationMessage[],
  direction: "in" | "out",
): AuditConversationMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.direction === direction && isRelevantMessage(message)) return message;
  }
  return null;
}

function containsQuestionSignal(value: string): boolean {
  const normalized = normalizeMessageText(value).toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("?")) return true;
  return /\b(que|qué|como|cómo|cuando|cuándo|donde|dónde|cuál|cual|por que|por qué|todavia|todavía|disponible|me ayudas)\b/i.test(normalized);
}

function containsPromiseSignal(value: string): boolean {
  const normalized = normalizeMessageText(value).toLowerCase();
  if (!normalized) return false;
  return /\b(te (envio|mando|paso|comparto|confirmo|aviso|digo)|ya te (envio|mando|paso|comparto|confirmo|aviso|digo)|ahora te (envio|mando|paso|comparto|confirmo|aviso|digo))\b/i.test(normalized);
}

function classifyWaitingOn(lastRelevant: AuditConversationMessage | null): AuditWaitingOn {
  if (!lastRelevant) return "unknown";
  if (lastRelevant.direction === "in") return "us";
  if (lastRelevant.direction === "out") return "them";
  return "unknown";
}

function classifyStallType(args: {
  waitingOn: AuditWaitingOn;
  idleMinutes: number | null;
  staleAfterMinutes: number;
  signals: string[];
}): AuditStallType {
  const { waitingOn, idleMinutes, staleAfterMinutes, signals } = args;
  if (signals.includes("unresolved_promise")) return "unresolved_promise";
  if (signals.includes("open_question")) return "open_question";
  if (waitingOn === "us" && signals.includes("follow_up_needed")) return "follow_up_needed";
  if (waitingOn === "us" && (idleMinutes ?? 0) >= staleAfterMinutes) return "waiting_on_us";
  if (waitingOn === "them" && (idleMinutes ?? 0) >= staleAfterMinutes * 3) return "waiting_on_them";
  if ((idleMinutes ?? 0) >= staleAfterMinutes) return "stalled_conversation";
  return "none";
}

function classifyPriority(stallType: AuditStallType, idleMinutes: number | null, staleAfterMinutes: number): AuditPriority {
  if (stallType === "unresolved_promise" || stallType === "open_question") return "high";
  if (stallType === "follow_up_needed" || stallType === "waiting_on_us") return "high";
  if (stallType === "stalled_conversation" && (idleMinutes ?? 0) >= staleAfterMinutes * 2) return "medium";
  if (stallType === "waiting_on_them") return "low";
  return "low";
}

function classifyStatus(priority: AuditPriority, waitingOn: AuditWaitingOn): AuditStatus {
  if (priority === "high") return "attention_needed";
  if (priority === "medium" || waitingOn === "us") return "watch";
  return "healthy";
}

function computeConfidence(signals: string[], idleMinutes: number | null, staleAfterMinutes: number): number {
  let score = 0.45;
  score += Math.min(0.25, signals.length * 0.08);
  if ((idleMinutes ?? 0) >= staleAfterMinutes) score += 0.15;
  if ((idleMinutes ?? 0) >= staleAfterMinutes * 2) score += 0.05;
  return Math.max(0.05, Math.min(0.99, Number(score.toFixed(2))));
}

function buildSuggestedAction(stallType: AuditStallType, waitingOn: AuditWaitingOn): string {
  switch (stallType) {
    case "open_question":
      return "Responder la pregunta abierta del cliente y cerrar el siguiente paso.";
    case "unresolved_promise":
      return "Cumplir la promesa pendiente o actualizar al cliente con una respuesta concreta.";
    case "follow_up_needed":
      return "Retomar el contacto con un seguimiento breve y accionable.";
    case "waiting_on_us":
      return "Responder al ultimo mensaje del cliente antes de que la conversacion se enfrie.";
    case "waiting_on_them":
      return "La conversacion esta esperando al cliente; conviene monitorear antes de insistir.";
    case "stalled_conversation":
      return waitingOn === "us"
        ? "Retomar la conversacion con una respuesta clara o siguiente paso."
        : "Evaluar si vale la pena reactivar el chat con un seguimiento.";
    default:
      return "No hay una accion urgente detectada en este tramo reciente.";
  }
}

function buildNextBestAction(stallType: AuditStallType, waitingOn: AuditWaitingOn): string | undefined {
  if (stallType === "open_question") return "Aclara la duda y propone confirmacion, link o siguiente accion.";
  if (stallType === "unresolved_promise") return "Entrega el dato prometido: precio, link, confirmacion o disponibilidad.";
  if (stallType === "follow_up_needed") return "Envía un seguimiento corto que reactive decision o respuesta.";
  if (stallType === "waiting_on_us" && waitingOn === "us") return "Contestar hoy mismo.";
  return undefined;
}

function findLastOutboundRelevantIndex(messages: AuditConversationMessage[], targetIndex: number): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.direction === "out" && message.index === targetIndex) {
      return index;
    }
  }
  return -1;
}

export function analyzeGenericConversation(args: {
  chatName: string;
  chatKey?: string;
  unreadCount: number;
  messages: AuditConversationMessage[];
  staleAfterMinutes: number;
}): AuditConversationItem {
  const { chatName, chatKey, unreadCount, messages, staleAfterMinutes } = args;
  const lastRelevant = findLastRelevantMessage(messages);
  const lastIncoming = findLastRelevantByDirection(messages, "in");
  const lastOutgoing = findLastRelevantByDirection(messages, "out");
  const waitingOn = classifyWaitingOn(lastRelevant);
  const idleMinutes = computeIdleMinutes(lastRelevant);
  const signals: string[] = [];

  if (lastIncoming && containsQuestionSignal(lastIncoming.text) && waitingOn === "us") {
    signals.push("customer_question", "open_question");
  }

  if (lastOutgoing && containsPromiseSignal(lastOutgoing.text)) {
    const lastOutgoingIndex = findLastOutboundRelevantIndex(messages, lastOutgoing.index);
    const laterRelevantOutbound = messages.slice(lastOutgoingIndex + 1).some((message) => message.direction === "out" && isRelevantMessage(message));
    if (!laterRelevantOutbound) {
      signals.push("business_promise", "unresolved_promise");
    }
  }

  if (waitingOn === "us") {
    signals.push("awaiting_business_response");
    if ((idleMinutes ?? 0) >= staleAfterMinutes) {
      signals.push("follow_up_needed");
    }
  } else if (waitingOn === "them") {
    signals.push("awaiting_customer_response");
  }

  if ((idleMinutes ?? 0) >= staleAfterMinutes) {
    signals.push("conversation_idle");
  }

  const stallType = classifyStallType({ waitingOn, idleMinutes, staleAfterMinutes, signals });
  const priority = classifyPriority(stallType, idleMinutes, staleAfterMinutes);
  const status = classifyStatus(priority, waitingOn);

  return {
    chatName,
    chatKey: chatKey ?? null,
    unreadCount,
    priority,
    status,
    waitingOn,
    stallType,
    idleMinutes,
    confidence: computeConfidence(signals, idleMinutes, staleAfterMinutes),
    signals,
    lastRelevantMessage: extractRelevantText(lastRelevant),
    suggestedAction: buildSuggestedAction(stallType, waitingOn),
    nextBestAction: buildNextBestAction(stallType, waitingOn),
  };
}
