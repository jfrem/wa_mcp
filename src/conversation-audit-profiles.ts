import type { AuditConversationItem, AuditConversationMessage } from "./conversation-audit-types.js";

function normalizeText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractLastMeaningfulIncoming(messages: AuditConversationMessage[]): AuditConversationMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.direction !== "in") continue;
    const normalized = normalizeText(message.text);
    if (normalized && normalized !== "[imagen]" && normalized !== "[nota de voz]") {
      return message;
    }
  }
  return null;
}

function extractLastMeaningfulOutgoing(messages: AuditConversationMessage[]): AuditConversationMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.direction !== "out") continue;
    const normalized = normalizeText(message.text);
    if (normalized && normalized !== "[imagen]" && normalized !== "[nota de voz]") {
      return message;
    }
  }
  return null;
}

function extractLastMeaningfulMessage(messages: AuditConversationMessage[]): AuditConversationMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const normalized = normalizeText(message.text);
    if (normalized && normalized !== "[imagen]" && normalized !== "[nota de voz]") {
      return message;
    }
  }
  return null;
}

function detectSalesSignal(text: string): "low" | "medium" | "high" {
  const normalized = normalizeText(text);
  if (!normalized) return "low";
  if (/\b(comprar|lo quiero|quiero uno|quiero pedir|cómo pago|como pago|link de pago|pasame el link|pásame el link|cual subo|cual me recomiendas|cargue el link)\b/i.test(normalized)) {
    return "high";
  }
  if (/\b(precio|valor|cuanto cuesta|cuánto cuesta|disponible|todavia tienes|todavía tienes|me interesa|informacion|información)\b/i.test(normalized)) {
    return "medium";
  }
  return "low";
}

function detectObjection(text: string): boolean {
  const normalized = normalizeText(text);
  return /\b(caro|muy caro|despues|después|luego|te aviso|lo voy a pensar|déjame pensarlo|dejame pensarlo|no se|no sé)\b/i.test(normalized);
}

function detectPendingCommercialPromise(text: string): boolean {
  const normalized = normalizeText(text);
  return /\b(precio|catalogo|catálogo|link|pago|direccion|dirección|ubicacion|ubicación|disponibilidad|horario)\b/i.test(normalized);
}

function inferSalesStage(text: string, objection: boolean): string {
  const normalized = normalizeText(text);
  if (objection) return "objection";
  if (/\b(comprar|como pago|cómo pago|link de pago|quiero pedir)\b/i.test(normalized)) return "closing";
  if (/\b(precio|valor|disponible|informacion|información|catalogo|catálogo)\b/i.test(normalized)) return "interest";
  return "exploration";
}

export function applySalesProfile(
  base: AuditConversationItem,
  messages: AuditConversationMessage[],
): AuditConversationItem {
  const lastIncoming = extractLastMeaningfulIncoming(messages);
  const lastOutgoing = extractLastMeaningfulOutgoing(messages);
  const lastRelevant = extractLastMeaningfulMessage(messages);
  const activeIncomingText = lastRelevant?.direction === "in" ? lastRelevant.text : "";
  const incomingText = activeIncomingText;
  const outgoingText = lastOutgoing?.text ?? "";
  const salesSignal = detectSalesSignal(incomingText);
  const objectionDetected = detectObjection(incomingText);
  const pendingCommercialPromise = detectPendingCommercialPromise(outgoingText) && base.signals.includes("unresolved_promise");
  const closeNotAttempted = salesSignal === "high" && base.waitingOn === "us" && !/\b(pago|link|pedido|confirma|confirmar|transferencia)\b/i.test(normalizeText(outgoingText));

  const signals = [...base.signals];
  if (salesSignal !== "low") signals.push(`sales_signal_${salesSignal}`);
  if (objectionDetected) signals.push("sales_objection");
  if (pendingCommercialPromise) signals.push("sales_pending_offer");
  if (closeNotAttempted) signals.push("sales_close_not_attempted");

  let priority = base.priority;
  if (salesSignal === "high" && base.waitingOn === "us") {
    priority = "high";
  } else if (salesSignal === "medium" && priority === "low") {
    priority = "medium";
  }

  const recommendedSalesAction =
    objectionDetected ? "Responder la objecion y recuperar traccion comercial." :
    pendingCommercialPromise ? "Enviar el dato comercial prometido y pedir confirmacion." :
    closeNotAttempted ? "Intentar cierre con siguiente paso concreto: pago, link o confirmacion." :
    salesSignal === "high" ? "Responder rapido y empujar al siguiente paso de cierre." :
    salesSignal === "medium" ? "Responder interes comercial y aclarar precio/disponibilidad." :
    base.suggestedAction;

  return {
    ...base,
    priority,
    status: priority === "high" ? "attention_needed" : base.status,
    confidence: Math.min(0.99, Number((base.confidence + (salesSignal === "high" ? 0.12 : salesSignal === "medium" ? 0.06 : 0)).toFixed(2))),
    signals,
    suggestedAction: recommendedSalesAction,
    nextBestAction: recommendedSalesAction,
    profileData: {
      salesStage: inferSalesStage(incomingText, objectionDetected),
      salesSignal,
      lossRisk: priority === "high" ? "high" : priority === "medium" ? "medium" : "low",
      objectionDetected,
      pendingCommercialPromise,
      closeNotAttempted,
      recommendedSalesAction,
    },
  };
}
