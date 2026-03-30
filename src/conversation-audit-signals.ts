import type {
  AuditConversationItem,
  AuditConversationMessage,
  AuditPriority,
  AuditStallType,
  AuditStatus,
  AuditWaitingOn,
} from "./conversation-audit-types.js";
import { buildConversationState, extractRelevantConversationText } from "./conversation-state/engine.js";
import { mapConversationScoreToPriority, scoreConversationState } from "./conversation-state/scoring.js";
import type { ConversationState } from "./conversation-state/types.js";

function truncate(value: string, maxLength = 140): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(1, maxLength - 1)).trim()}...`;
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

function classifyStatus(priority: AuditPriority, waitingOn: AuditWaitingOn): AuditStatus {
  if (priority === "high") return "attention_needed";
  if (priority === "medium" || waitingOn === "us") return "watch";
  return "healthy";
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

function buildSignalNames(state: ConversationState): string[] {
  return state.signals.map((signal) => signal.type);
}

export function analyzeGenericConversationState(state: ConversationState): AuditConversationItem {
  const signals = buildSignalNames(state);
  const score = scoreConversationState(state);
  const stallType = classifyStallType({
    waitingOn: state.waitingOn,
    idleMinutes: state.idleMinutes,
    staleAfterMinutes: state.staleAfterMinutes,
    signals,
  });
  const priority = mapConversationScoreToPriority(score.score);
  const status = classifyStatus(priority, state.waitingOn);

  return {
    chatName: state.chatName,
    chatKey: state.chatKey,
    unreadCount: state.unreadCount,
    priority,
    status,
    waitingOn: state.waitingOn,
    stallType,
    idleMinutes: state.idleMinutes,
    confidence: state.confidence,
    signals,
    lastRelevantMessage: truncate(extractRelevantConversationText(state.lastRelevantMessage) ?? "", 140) || null,
    suggestedAction: buildSuggestedAction(stallType, state.waitingOn),
    nextBestAction: buildNextBestAction(stallType, state.waitingOn),
  };
}

export function analyzeGenericConversation(args: {
  chatName: string;
  chatKey?: string;
  unreadCount: number;
  messages: AuditConversationMessage[];
  staleAfterMinutes: number;
}): AuditConversationItem {
  const state = buildConversationState({
    chatName: args.chatName,
    chatKey: args.chatKey ?? null,
    unreadCount: args.unreadCount,
    messages: args.messages,
    staleAfterMinutes: args.staleAfterMinutes,
  });
  return analyzeGenericConversationState(state);
}
