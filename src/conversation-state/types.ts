export interface ConversationStateMessage {
  index: number;
  direction: "in" | "out" | "unknown";
  text: string;
  meta?: string;
  mediaKind?: "image" | "voice_note";
}

export interface ConversationSignal {
  type: string;
  score: number;
  evidence: string;
}

export interface ConversationStateInput {
  chatName: string;
  chatKey?: string | null;
  unreadCount: number;
  messages: ConversationStateMessage[];
  staleAfterMinutes: number;
  now?: number;
}

export interface ConversationState {
  chatName: string;
  chatKey: string | null;
  unreadCount: number;
  messages: ConversationStateMessage[];
  staleAfterMinutes: number;
  lastRelevantMessage: ConversationStateMessage | null;
  lastInboundMessage: ConversationStateMessage | null;
  lastOutboundMessage: ConversationStateMessage | null;
  lastRelevantText: string | null;
  waitingOn: "us" | "them" | "unknown";
  idleMinutes: number | null;
  confidence: number;
  signals: ConversationSignal[];
  summary: string;
}
