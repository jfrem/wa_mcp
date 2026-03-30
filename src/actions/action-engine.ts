import { createHash } from "node:crypto";
import { listChats, readMessages, type ChatSummary } from "../whatsapp.js";
import { buildConversationState } from "../conversation-state/engine.js";
import type { ConversationState } from "../conversation-state/types.js";
import { getActionStrategy, listActionStrategies } from "./strategy-registry.js";
import {
  ACTION_MAX_LIMIT,
  DEFAULT_ACTION_LIMIT,
  DEFAULT_ACTION_STRATEGIES,
  type ActionableFeedItem,
  type ActionableFeedResult,
  type ActionStrategyName,
  type DetectedAction,
  type SuggestedAction,
} from "./types.js";

export interface GetActionableFeedOptions {
  chatKeys?: string[];
  strategies?: string[];
  limit?: number;
  messageLimit?: number;
  staleAfterMinutes?: number;
}

interface ActionEngineDependencies {
  listChatsFn: typeof listChats;
  readMessagesFn: typeof readMessages;
  now: () => number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveStrategies(requested: string[] | undefined, warnings: string[]): ActionStrategyName[] {
  const requestedNames = (requested ?? []).map((item) => item.trim()).filter(Boolean);
  const names = requestedNames.length ? requestedNames : [...DEFAULT_ACTION_STRATEGIES];
  const resolved: ActionStrategyName[] = [];
  for (const name of names) {
    if (!getActionStrategy(name)) {
      warnings.push(`Estrategia desconocida omitida: ${name}.`);
      continue;
    }
    resolved.push(name as ActionStrategyName);
  }
  if (requestedNames.length) {
    return resolved;
  }
  return resolved.length ? resolved : [...DEFAULT_ACTION_STRATEGIES];
}

function resolveTargetChats(visibleChats: ChatSummary[], chatKeys: string[] | undefined, warnings: string[], limit: number): ChatSummary[] {
  if (!chatKeys?.length) {
    return visibleChats.slice(0, Math.max(limit * 3, 30));
  }

  const byChatKey = new Map(visibleChats.map((chat) => [chat.chatKey, chat] as const));
  const targets: ChatSummary[] = [];
  for (const chatKey of chatKeys.map((item) => item.trim()).filter(Boolean)) {
    const chat = byChatKey.get(chatKey);
    if (!chat) {
      warnings.push(`Chat omitido por no estar visible o no encontrado: ${chatKey}.`);
      continue;
    }
    targets.push(chat);
  }
  return targets;
}

function sortActions(actions: SuggestedAction[]): SuggestedAction[] {
  return [...actions].sort((left, right) => right.priority - left.priority || left.label.localeCompare(right.label));
}

function buildActionId(chatKey: string, action: DetectedAction, state: ConversationState): string {
  return createHash("sha256")
    .update([
      chatKey,
      action.strategy,
      action.type,
      state.lastRelevantMessage?.index ?? 0,
      state.lastRelevantText ?? "",
    ].join("::"))
    .digest("hex")
    .slice(0, 16);
}

function buildPreviewArgs(chatKey: string, kind: string, messageLimit: number): Record<string, unknown> {
  return {
    chat_key: chatKey,
    tone: kind === "follow_up" ? "warm" : "neutral",
    message_limit: messageLimit,
    media_limit: 2,
    include_transcriptions: false,
    include_image_descriptions: false,
  };
}

function buildActionSeedReply(action: DetectedAction): string | undefined {
  const previewText = action.preview.text.trim();
  return action.type === "follow_up" && previewText ? previewText : undefined;
}

function buildReviewArgs(chatKey: string, kind: string, messageLimit: number): Record<string, unknown> {
  return {
    ...buildPreviewArgs(chatKey, kind, messageLimit),
    review_ttl_seconds: 600,
  };
}

function hydrateAction(
  chat: ChatSummary,
  action: DetectedAction,
  state: ConversationState,
  generatedAt: string,
  messageLimit: number,
): SuggestedAction {
  const chatKey = state.chatKey ?? chat.chatKey;
  const seedReply = buildActionSeedReply(action);
  const blockingSignals = state.signals
    .map((signal) => signal.type)
    .filter((signal) => signal === "open_question" || signal === "unresolved_promise");
  const defaultPreviewArgs = buildPreviewArgs(chatKey, action.type, messageLimit);
  const defaultRecommendedArgs = buildReviewArgs(chatKey, action.type, messageLimit);
  if (seedReply) {
    defaultPreviewArgs.seed_reply = seedReply;
    defaultRecommendedArgs.seed_reply = seedReply;
  }

  return {
    ...action,
    actionId: action.actionId ?? buildActionId(chatKey, action, state),
    chatKey,
    kind: action.kind ?? action.type,
    confidence: action.confidence ?? state.confidence,
    evidence: action.evidence ?? state.signals.slice(0, 3).map((signal) => signal.evidence),
    generatedAt: action.generatedAt ?? generatedAt,
    recommendedTool: action.recommendedTool ?? "review_reply_for_confirmation",
    recommendedArgs: action.recommendedArgs ?? defaultRecommendedArgs,
    previewTool: action.previewTool ?? "draft_reply_with_media_context",
    previewArgs: action.previewArgs ?? defaultPreviewArgs,
    confirmTool: action.confirmTool ?? "confirm_reviewed_reply",
    executionMode: action.executionMode ?? "review_then_confirm",
    blockingSignals: action.blockingSignals ?? blockingSignals,
    requiresHumanReview: action.requiresHumanReview ?? true,
  };
}

function buildItem(chat: ChatSummary, actions: SuggestedAction[], summary: string): ActionableFeedItem {
  const sortedActions = sortActions(actions).map((action) => ({
    ...action,
    priority: clamp(Number(action.priority.toFixed(2)), 0, 1),
  }));
  const topAction = sortedActions[0];
  return {
    chatId: chat.chatKey,
    priority: topAction?.priority ?? 0,
    reason: topAction?.reason ?? "No se detectaron acciones.",
    summary,
    actions: sortedActions,
  };
}

export async function getActionableFeed(
  port: number,
  options: GetActionableFeedOptions = {},
  dependencies?: Partial<ActionEngineDependencies>,
): Promise<ActionableFeedResult> {
  const deps: ActionEngineDependencies = {
    listChatsFn: dependencies?.listChatsFn ?? listChats,
    readMessagesFn: dependencies?.readMessagesFn ?? readMessages,
    now: dependencies?.now ?? (() => Date.now()),
  };
  const warnings: string[] = [];
  const limit = clamp(Math.trunc(options.limit ?? DEFAULT_ACTION_LIMIT), 1, ACTION_MAX_LIMIT);
  const messageLimit = clamp(Math.trunc(options.messageLimit ?? 20), 1, 100);
  const staleAfterMinutes = clamp(Math.trunc(options.staleAfterMinutes ?? 30), 1, 10080);
  const strategies = resolveStrategies(options.strategies, warnings);
  const visibleChats = await deps.listChatsFn(port, ACTION_MAX_LIMIT);
  const targets = resolveTargetChats(visibleChats, options.chatKeys, warnings, limit);
  const items: ActionableFeedItem[] = [];

  for (const chat of targets) {
    try {
      const messages = await deps.readMessagesFn(port, chat.title, messageLimit, undefined, { chatKey: chat.chatKey });
      const conversationState = buildConversationState({
        chatName: chat.title,
        chatKey: chat.chatKey,
        unreadCount: chat.unreadCount,
        messages,
        staleAfterMinutes,
        now: deps.now(),
      });
      const generatedAt = new Date(deps.now()).toISOString();
      const actions = strategies.flatMap((name) => {
        const strategy = getActionStrategy(name);
        if (!strategy) return [];
        return strategy
          .detect({ conversationState })
          .map((action) => hydrateAction(chat, action, conversationState, generatedAt, messageLimit));
      });
      if (!actions.length) continue;
      items.push(buildItem(chat, actions, conversationState.summary));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`No se pudo evaluar acciones para "${chat.title}": ${detail}`);
    }
  }

  items.sort((left, right) => right.priority - left.priority || left.chatId.localeCompare(right.chatId));
  const data = items.slice(0, limit);
  return {
    data,
    meta: {
      has_more: items.length > data.length,
    },
    warnings,
  };
}

export { listActionStrategies };
