import { scoreActionSuggestion } from "../../conversation-state/scoring.js";
import type { ActionStrategy, DetectedAction } from "../types.js";

function buildPreview(chatName: string): string {
  return `Hola, ${chatName}. Retomo esta conversacion por aqui para ayudarte a cerrar el siguiente paso. Si quieres, te comparto el detalle ahora mismo.`;
}

export const followUpSimpleStrategy: ActionStrategy = {
  name: "follow_up_simple",
  detect(context) {
    const { conversationState } = context;
    if (conversationState.unreadCount > 0) return [];

    const lastRelevant = conversationState.lastRelevantMessage;
    if (!lastRelevant || conversationState.waitingOn !== "them" || lastRelevant.direction !== "out") return [];

    if (!conversationState.lastInboundMessage) return [];

    const idleMinutes = conversationState.idleMinutes ?? 0;
    const minimumFollowUpIdleMinutes = Math.max(conversationState.staleAfterMinutes * 3, 1);
    if (idleMinutes < minimumFollowUpIdleMinutes) return [];

    const action: DetectedAction = {
      type: "follow_up",
      label: "Hacer follow-up",
      priority: scoreActionSuggestion(conversationState, "follow_up"),
      reason: `El ultimo mensaje fue del negocio hace ${idleMinutes} minuto(s) y el cliente no respondio. Conviene reactivar la conversacion.`,
      preview: { text: buildPreview(conversationState.chatName) },
      strategy: "follow_up_simple",
    };

    return [action];
  },
};
