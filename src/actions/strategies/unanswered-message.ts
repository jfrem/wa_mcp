import { suggestReplyFromTimeline } from "../../reply-suggestion.js";
import { normalizeConversationText } from "../../conversation-state/engine.js";
import { scoreActionSuggestion } from "../../conversation-state/scoring.js";
import type { ActionStrategy, DetectedAction } from "../types.js";

function buildReason(messageText: string, idleMinutes: number, unreadCount: number): string {
  if (messageText) {
    return `El ultimo mensaje relevante del cliente sigue sin respuesta tras ${idleMinutes} minuto(s). Unread visibles: ${unreadCount}.`;
  }
  return `El cliente dejo un mensaje multimedia sin respuesta y el chat lleva ${idleMinutes} minuto(s) esperando.`;
}

export const unansweredMessageStrategy: ActionStrategy = {
  name: "unanswered_message",
  detect(context) {
    const { conversationState } = context;
    const lastRelevant = conversationState.lastRelevantMessage;
    if (!lastRelevant || conversationState.waitingOn !== "us" || lastRelevant.direction !== "in") return [];

    const meaningfulText = normalizeConversationText(lastRelevant.text);
    const idleMinutes = conversationState.idleMinutes ?? 0;
    const priority = scoreActionSuggestion(conversationState, "reply");
    const previewText = suggestReplyFromTimeline(conversationState.messages, { tone: "neutral", maxLength: 160 });

    const action: DetectedAction = {
      type: "reply",
      label: "Responder ahora",
      priority,
      reason: buildReason(meaningfulText, idleMinutes, conversationState.unreadCount),
      preview: { text: previewText },
      strategy: "unanswered_message",
    };

    return [action];
  },
};
