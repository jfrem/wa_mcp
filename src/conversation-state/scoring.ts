import { normalizeConversationText } from "./engine.js";
import type { ConversationState } from "./types.js";

export interface ConversationPriorityScore {
  score: number;
  components: {
    waitingOnUs: number;
    waitingOnThem: number;
    unread: number;
    openQuestion: number;
    unresolvedPromise: number;
    inactivity: number;
    confidenceMultiplier: number;
  };
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function hasSignal(state: ConversationState, signalType: string): boolean {
  return state.signals.some((signal) => signal.type === signalType);
}

function inactivityComponent(state: ConversationState): number {
  if (state.idleMinutes === null) return 0;
  const normalized = clamp(state.idleMinutes / Math.max(state.staleAfterMinutes * 2, 1));
  return Number((normalized * 0.16).toFixed(2));
}

export function scoreConversationState(state: ConversationState): ConversationPriorityScore {
  const waitingOnUs = state.waitingOn === "us" ? 0.2 : 0;
  const waitingOnThem = state.waitingOn === "them" ? 0.08 : 0;
  const unread = state.unreadCount > 0 ? 0.1 : 0;
  const openQuestion = hasSignal(state, "open_question") ? 0.28 : 0;
  const unresolvedPromise = hasSignal(state, "unresolved_promise") ? 0.42 : 0;
  const inactivity = inactivityComponent(state);
  const confidenceMultiplier = Number((0.6 + state.confidence * 0.4).toFixed(2));
  const rawScore = waitingOnUs + waitingOnThem + unread + openQuestion + unresolvedPromise + inactivity;

  return {
    score: clamp(Number((rawScore * confidenceMultiplier).toFixed(2))),
    components: {
      waitingOnUs,
      waitingOnThem,
      unread,
      openQuestion,
      unresolvedPromise,
      inactivity,
      confidenceMultiplier,
    },
  };
}

export function mapConversationScoreToPriority(score: number): "low" | "medium" | "high" {
  if (score >= 0.55) return "high";
  if (score >= 0.3) return "medium";
  return "low";
}

export function scoreActionSuggestion(state: ConversationState, kind: "reply" | "follow_up"): number {
  const base = scoreConversationState(state).score;
  if (kind === "reply") {
    const boosted = base
      + (state.waitingOn === "us" ? 0.12 : 0)
      + (hasSignal(state, "open_question") ? 0.1 : 0)
      + (state.unreadCount > 0 ? 0.08 : 0);
    return clamp(Number(boosted.toFixed(2)));
  }

  const outboundText = normalizeConversationText(state.lastOutboundMessage?.text ?? "");
  const commercialBoost = /\b(precio|pago|link|cotizacion|cotización|pedido|confirmacion|confirmación|disponible)\b/i.test(outboundText) ? 0.1 : 0;
  const followUpThresholdMinutes = Math.max(state.staleAfterMinutes * 3, 1);
  const followUpBoost =
    state.waitingOn === "them" && (state.idleMinutes ?? 0) >= followUpThresholdMinutes
      ? 0.18
      : state.waitingOn === "them"
        ? 0.08
        : 0;
  return clamp(Number((base + followUpBoost + commercialBoost).toFixed(2)));
}
