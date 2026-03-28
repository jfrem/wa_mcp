import { listChats, listUnreadChats, readMessages, searchChats } from "./whatsapp.js";
import { analyzeGenericConversation } from "./conversation-audit-signals.js";
import { applySalesProfile } from "./conversation-audit-profiles.js";
import type { AuditConversationMessage, AuditConversationsResult, AuditProfile, AuditScope } from "./conversation-audit-types.js";

type ChatSummaryLike = Awaited<ReturnType<typeof listChats>>[number];
type SearchResultLike = Awaited<ReturnType<typeof searchChats>>[number];
type AuditTarget = {
  title: string;
  chatKey: string;
  unreadCount: number;
};

export interface AuditConversationsOptions {
  profile: AuditProfile;
  scope: "visible" | "unread";
  maxChats: number;
  messageLimit: number;
  staleAfterMinutes: number;
  query?: string;
  chatKeys?: string[];
}

function sortPriority(priority: "low" | "medium" | "high"): number {
  if (priority === "high") return 3;
  if (priority === "medium") return 2;
  return 1;
}

function mapMessages(messages: Awaited<ReturnType<typeof readMessages>>): AuditConversationMessage[] {
  return messages.map((message) => ({
    index: message.index,
    direction: message.direction,
    text: message.text,
    meta: message.meta,
    mediaKind: message.mediaKind,
  }));
}

function dedupeTargets(targets: AuditTarget[], limit: number): AuditTarget[] {
  const seen = new Set<string>();
  const deduped: AuditTarget[] = [];
  for (const target of targets) {
    const key = target.chatKey.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(target);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

export function selectAuditTargets(args: {
  maxChats: number;
  scope: "visible" | "unread";
  query?: string;
  chatKeys?: string[];
  visibleChats: ChatSummaryLike[];
  unreadChats: ChatSummaryLike[];
  searchResults: SearchResultLike[];
}): { scope: AuditScope; targets: AuditTarget[] } {
  const normalizedChatKeys = (args.chatKeys ?? []).map((item) => item.trim()).filter(Boolean);
  if (normalizedChatKeys.length) {
    const visibleLookup = new Map(args.visibleChats.map((chat) => [chat.chatKey, chat] as const));
    return {
      scope: "chat_keys",
      targets: dedupeTargets(
        normalizedChatKeys.map((chatKey) => {
          const visible = visibleLookup.get(chatKey);
          return {
            title: visible?.title ?? chatKey,
            chatKey,
            unreadCount: visible?.unreadCount ?? 0,
          };
        }),
        args.maxChats,
      ),
    };
  }

  const normalizedQuery = (args.query ?? "").trim().toLowerCase();
  if (normalizedQuery) {
    const filteredResults = args.searchResults.filter((chat) => {
      const title = chat.title.trim().toLowerCase();
      const preview = chat.lastMessagePreview.trim().toLowerCase();
      return title.includes(normalizedQuery) || preview.includes(normalizedQuery);
    });
    return {
      scope: "query",
      targets: dedupeTargets(
        filteredResults.map((chat) => ({
          title: chat.title,
          chatKey: chat.chatKey,
          unreadCount: chat.unreadCount,
        })),
        args.maxChats,
      ),
    };
  }

  return {
    scope: args.scope,
    targets: dedupeTargets(
      (args.scope === "unread" ? args.unreadChats : args.visibleChats).map((chat) => ({
        title: chat.title,
        chatKey: chat.chatKey,
        unreadCount: chat.unreadCount,
      })),
      args.maxChats,
    ),
  };
}

export async function auditConversations(
  port: number,
  options: AuditConversationsOptions,
): Promise<AuditConversationsResult> {
  const warnings: string[] = [];
  const needsVisibleChats = Boolean(options.chatKeys?.length) || options.scope === "visible";
  const visibleChats = needsVisibleChats ? await listChats(port, Math.max(options.maxChats, options.chatKeys?.length ?? 0)) : [];
  const unreadChats = options.scope === "unread" && !options.query && !(options.chatKeys?.length)
    ? await listUnreadChats(port, options.maxChats)
    : [];
  const searchResults = options.query?.trim()
    ? await searchChats(port, options.query.trim(), options.maxChats)
    : [];
  const selection = selectAuditTargets({
    maxChats: options.maxChats,
    scope: options.scope,
    query: options.query,
    chatKeys: options.chatKeys,
    visibleChats,
    unreadChats,
    searchResults,
  });
  const chats = selection.targets;

  const items = [];
  for (const chat of chats) {
    try {
      const messages = await readMessages(port, chat.title, options.messageLimit, undefined, { chatKey: chat.chatKey });
      const mappedMessages = mapMessages(messages);
      const item = analyzeGenericConversation({
        chatName: chat.title,
        chatKey: chat.chatKey,
        unreadCount: chat.unreadCount,
        messages: mappedMessages,
        staleAfterMinutes: options.staleAfterMinutes,
      });
      items.push(options.profile === "sales" ? applySalesProfile(item, mappedMessages) : item);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`No se pudo auditar "${chat.title}": ${detail}`);
    }
  }

  items.sort((left, right) => {
    const priorityDiff = sortPriority(right.priority) - sortPriority(left.priority);
    if (priorityDiff !== 0) return priorityDiff;
    const leftIdle = left.idleMinutes ?? -1;
    const rightIdle = right.idleMinutes ?? -1;
    if (rightIdle !== leftIdle) return rightIdle - leftIdle;
    return left.chatName.localeCompare(right.chatName);
  });

  return {
    ok: true,
    profile: options.profile,
    scope: selection.scope,
    count: items.length,
    items,
    warnings,
  };
}
