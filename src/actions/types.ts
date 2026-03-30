import type { ConversationState } from "../conversation-state/types.js";

export const ACTION_MAX_LIMIT = 50;
export const DEFAULT_ACTION_LIMIT = 20;
export const DEFAULT_ACTION_STRATEGIES = ["unanswered_message", "follow_up_simple"] as const;

export type ActionStrategyName = typeof DEFAULT_ACTION_STRATEGIES[number];

export interface ActionPreview {
  text: string;
}

export type ActionExecutionMode = "review_then_confirm";

export interface DetectedAction {
  actionId?: string;
  chatKey?: string;
  type: string;
  kind?: string;
  label: string;
  priority: number;
  reason: string;
  preview: ActionPreview;
  strategy: string;
  confidence?: number;
  evidence?: string[];
  generatedAt?: string;
  expiresAt?: string;
  cooldownUntil?: string;
  recommendedTool?: string;
  recommendedArgs?: Record<string, unknown>;
  previewTool?: string;
  previewArgs?: Record<string, unknown>;
  confirmTool?: string;
  executionMode?: ActionExecutionMode;
  blockingSignals?: string[];
  requiresHumanReview?: boolean;
}

export interface SuggestedAction {
  actionId: string;
  chatKey: string;
  type: string;
  kind?: string;
  label: string;
  priority: number;
  reason: string;
  preview: ActionPreview;
  strategy: string;
  recommendedTool: string;
  recommendedArgs: Record<string, unknown>;
  executionMode: ActionExecutionMode;
  requiresHumanReview: boolean;
  confidence?: number;
  evidence?: string[];
  generatedAt?: string;
  expiresAt?: string;
  cooldownUntil?: string;
  previewTool?: string;
  previewArgs?: Record<string, unknown>;
  confirmTool?: string;
  blockingSignals?: string[];
}

export interface ActionableFeedItem {
  chatId: string;
  priority: number;
  reason: string;
  summary: string;
  actions: SuggestedAction[];
}

export interface ActionableFeedResult {
  data: ActionableFeedItem[];
  meta: {
    has_more: boolean;
  };
  warnings: string[];
}

export interface ActionStrategyContext {
  conversationState: ConversationState;
}

export interface ActionStrategy {
  name: string;
  detect(context: ActionStrategyContext): DetectedAction[];
}
