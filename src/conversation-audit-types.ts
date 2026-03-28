export type AuditProfile = "generic" | "sales";
export type AuditScope = "visible" | "unread" | "query" | "chat_keys";
export type AuditPriority = "low" | "medium" | "high";
export type AuditStatus = "healthy" | "watch" | "attention_needed";
export type AuditWaitingOn = "us" | "them" | "unknown";
export type AuditStallType =
  | "none"
  | "waiting_on_us"
  | "waiting_on_them"
  | "open_question"
  | "stalled_conversation"
  | "unresolved_promise"
  | "follow_up_needed";

export interface AuditConversationMessage {
  index: number;
  direction: "in" | "out" | "unknown";
  text: string;
  meta?: string;
  mediaKind?: "image" | "voice_note";
}

export interface AuditConversationItem {
  chatName: string;
  chatKey: string | null;
  unreadCount: number;
  priority: AuditPriority;
  status: AuditStatus;
  waitingOn: AuditWaitingOn;
  stallType: AuditStallType;
  idleMinutes: number | null;
  confidence: number;
  signals: string[];
  lastRelevantMessage: string | null;
  suggestedAction: string;
  nextBestAction?: string;
  profileData?: Record<string, unknown>;
}

export interface AuditConversationsResult {
  ok: true;
  profile: AuditProfile;
  scope: AuditScope;
  count: number;
  items: AuditConversationItem[];
  warnings: string[];
}
