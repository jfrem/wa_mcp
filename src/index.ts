import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  autoAuth,
  applyChatFilter,
  checkAuth,
  clearSearch,
  downloadImageMessage,
  downloadLatestVoiceNote,
  buildTimelineMediaPointers,
  listImageMessages,
  listVoiceNotes,
  listChats,
  listUnreadChats,
  openChatBySearch,
  pickLatestMediaPointer,
  readMessages,
  searchChats,
  sendMessage,
  waitForActivityEvent,
} from "./whatsapp.js";
import { transcribeLatestVoiceNote } from "./transcription.js";
import { describeImageFile } from "./image-description.js";
import { summarizeTimelineMessages } from "./timeline-summary.js";
import { buildReplyDraftFromTimeline, MAX_REPLY_DRAFT_ALTERNATIVES, resolveReplySelection } from "./draft-reply.js";
import { auditConversations } from "./conversation-audit.js";
import { buildConversationAttentionBoardFromAudit } from "./conversation-attention-board.js";
import {
  assertValidReviewToken,
  createReviewToken,
  deleteReviewToken,
  loadReviewToken,
  saveReviewToken,
  type ReviewTokenContextOptions,
} from "./review-token-store.js";

const DEFAULT_PORT = Number(process.env.WHATSAPP_WEB_CDP_PORT ?? 9222);
const DEFAULT_REVIEW_TTL_SECONDS = 600;
const MAX_REVIEW_TTL_SECONDS = 3600;

function text(value: string) {
  return { content: [{ type: "text", text: value }] };
}

function requirePort(value: unknown, fallback = DEFAULT_PORT): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("remote_debugging_port invalido. Debe ser un entero entre 1 y 65535.");
  }
  return port;
}

function requireBoundedInt(value: unknown, label: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} invalido. Debe ser un entero entre ${min} y ${max}.`);
  }
  return parsed;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const parsed = typeof value === "string" ? value.trim() : "";
  if (!parsed) {
    throw new Error(`${label} es obligatorio.`);
  }
  return parsed;
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = value.trim();
  return parsed || undefined;
}

function requireChatIdentifier(args: Record<string, unknown>): { chatName: string; chatKey?: string } {
  const chatName = optionalTrimmedString(args.chat_name) ?? "";
  const chatKey = optionalTrimmedString(args.chat_key);
  if (!chatName && !chatKey) {
    throw new Error("Debes enviar chat_name o chat_key.");
  }
  return {
    chatName: chatName || chatKey || "",
    chatKey,
  };
}

function requireSearchWindow(
  args: Record<string, unknown>,
  defaults: { candidateLimit: number; messageLimit: number },
): { candidateLimit: number; messageLimit: number } {
  const legacyLimit = typeof args.limit === "number"
    ? requireBoundedInt(args.limit, "limit", defaults.messageLimit, 1, 200)
    : undefined;
  const messageLimit = typeof args.message_limit === "number"
    ? requireBoundedInt(args.message_limit, "message_limit", defaults.messageLimit, 1, 200)
    : (legacyLimit ?? defaults.messageLimit);
  const candidateLimit = typeof args.candidate_limit === "number"
    ? requireBoundedInt(args.candidate_limit, "candidate_limit", defaults.candidateLimit, 1, 50)
    : Math.min(50, Math.max(defaults.candidateLimit, legacyLimit ?? defaults.messageLimit, 25));
  return { candidateLimit, messageLimit };
}

function requireAllowedString(
  value: unknown,
  label: string,
  allowedValues: readonly string[],
): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = value.trim().toLowerCase();
  if (!parsed) return undefined;
  if (!allowedValues.includes(parsed)) {
    throw new Error(`${label} invalido. Valores permitidos: ${allowedValues.join(", ")}.`);
  }
  return parsed;
}

const TRANSCRIPTION_MODELS = ["tiny", "base", "small", "medium", "large-v3"] as const;
const TRANSCRIPTION_DEVICES = ["cpu", "cuda"] as const;
const TRANSCRIPTION_COMPUTE_TYPES = ["default", "auto", "int8", "int8_float16", "int8_float32", "float16", "float32"] as const;

function formatChats(chats: Awaited<ReturnType<typeof listChats>>): string {
  if (!chats.length) return "No se encontraron chats visibles.";
  return chats.map((chat) => {
    return [
      `#${chat.index} ${chat.title}`,
      `  unread: ${chat.unreadCount}`,
      `  selected: ${chat.selected ? "yes" : "no"}`,
      `  preview: ${chat.lastMessagePreview || "(sin preview)"}`,
    ].join("\n");
  }).join("\n\n");
}

function formatSearchResults(results: Awaited<ReturnType<typeof searchChats>>): string {
  if (!results.length) return "No se encontraron resultados visibles para la busqueda.";
  return results.map((chat) => {
    return [
      `#${chat.index} ${chat.title}`,
      `  unread: ${chat.unreadCount}`,
      `  reason: ${chat.matchReason}`,
      `  preview: ${chat.lastMessagePreview || "(sin preview)"}`,
    ].join("\n");
  }).join("\n\n");
}

function formatMessages(messages: Awaited<ReturnType<typeof readMessages>>): string {
  if (!messages.length) return "No se encontraron mensajes visibles.";
  return messages.map((message) => {
    return [
      `[${message.index}] ${message.direction}`,
      `meta: ${message.meta || "-"}`,
      message.text,
    ].join("\n");
  }).join("\n\n");
}

function formatVoiceNotes(notes: Awaited<ReturnType<typeof listVoiceNotes>>): string {
  if (!notes.length) return "No se encontraron notas de voz en el historial cargado.";
  return notes.map((note) => {
    return [
      `#${note.index} ${note.direction}`,
      `  duration: ${note.durationLabel || "-"}`,
      `  meta: ${note.meta || "-"}`,
      `  fingerprint: ${note.fingerprintSource}`,
    ].join("\n");
  }).join("\n\n");
}

function formatImages(images: Awaited<ReturnType<typeof listImageMessages>>): string {
  if (!images.length) return "No se encontraron imagenes reales en el historial cargado tras recorrer mensajes anteriores.";
  return images.map((image) => {
    return [
      `#${image.index} ${image.direction}`,
      `  meta: ${image.meta || "-"}`,
      `  caption: ${image.caption || "(sin caption)"}`,
      `  fingerprint: ${image.fingerprintSource}`,
    ].join("\n");
  }).join("\n\n");
}

async function getLatestMediaSummary(
  port: number,
  chatName: string,
  chatIndex: number | undefined,
  chatKey: string | undefined,
  options: {
    messageLimit: number;
    includeTranscription: boolean;
    direction: "in" | "out" | "any";
    language?: string;
    model?: string;
    beamSize?: number;
    device?: string;
    computeType?: string;
  },
) {
  const messages = await readMessages(port, chatName, options.messageLimit, chatIndex, { chatKey });
  const latestMedia = pickLatestMediaPointer(messages, options.direction);

  if (!latestMedia) {
    return {
      ok: true,
      found: false,
      chatName,
      chatKey: chatKey ?? null,
      scannedMessages: messages.length,
      detail: "No se encontro contenido multimedia reciente en los mensajes visibles/cargados.",
    };
  }

  if (latestMedia.kind === "image") {
    const imageIndex = latestMedia.mediaIndex;
    const downloaded = await downloadImageMessage(port, chatName, chatIndex, options.direction, {
      chatKey,
      imageIndex,
    });

    return {
      ok: true,
      found: true,
      kind: "image" as const,
      chatName,
      chatKey: chatKey ?? null,
      scannedMessages: messages.length,
      message: latestMedia.message,
      imageIndex,
      image: downloaded,
    };
  }

  const voiceNoteIndex = latestMedia.mediaIndex;

  if (options.includeTranscription) {
    try {
      const transcribed = await transcribeLatestVoiceNote(
        port,
        chatName,
        chatIndex,
        {
          language: options.language,
          model: options.model,
          beamSize: options.beamSize,
          device: options.device,
          computeType: options.computeType,
        },
        options.direction,
        { chatKey, voiceNoteIndex },
      );

      return {
        ok: true,
        found: true,
        kind: "voice_note" as const,
        chatName,
        chatKey: chatKey ?? null,
        scannedMessages: messages.length,
        message: latestMedia.message,
        voiceNoteIndex,
        voiceNote: transcribed,
      };
    } catch (error) {
      const downloaded = await downloadLatestVoiceNote(port, chatName, chatIndex, options.direction, { chatKey, voiceNoteIndex });
      return {
        ok: true,
        found: true,
        kind: "voice_note" as const,
        chatName,
        chatKey: chatKey ?? null,
        scannedMessages: messages.length,
        message: latestMedia.message,
        voiceNoteIndex,
        voiceNote: downloaded,
        transcription: {
          available: false,
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  const downloaded = await downloadLatestVoiceNote(port, chatName, chatIndex, options.direction, { chatKey, voiceNoteIndex });
  return {
    ok: true,
    found: true,
    kind: "voice_note" as const,
    chatName,
    chatKey: chatKey ?? null,
    scannedMessages: messages.length,
    message: latestMedia.message,
    voiceNoteIndex,
    voiceNote: downloaded,
  };
}

async function describeLatestImage(
  port: number,
  chatName: string,
  chatIndex: number | undefined,
  chatKey: string | undefined,
  options: {
    direction: "in" | "out" | "any";
    prompt?: string;
  },
) {
  const downloaded = await downloadImageMessage(port, chatName, chatIndex, options.direction, {
    chatKey,
    imageIndex: 1,
  });
  const description = await describeImageFile(downloaded.path, options.prompt);

  return {
    ok: true,
    chatName,
    chatKey: chatKey ?? null,
    image: downloaded,
    description,
  };
}

async function getChatTimelineSummary(
  port: number,
  chatName: string,
  chatIndex: number | undefined,
  chatKey: string | undefined,
  options: {
    messageLimit: number;
    mediaLimit: number;
    includeTranscriptions: boolean;
    includeImageDescriptions: boolean;
    direction: "in" | "out" | "any";
    prompt?: string;
    language?: string;
    model?: string;
    beamSize?: number;
    device?: string;
    computeType?: string;
  },
) {
  const messages = await readMessages(port, chatName, options.messageLimit, chatIndex, { chatKey });
  const pointers = buildTimelineMediaPointers(messages);
  const filteredPointers = buildTimelineMediaPointers(messages, options.direction);
  const pointersToEnrich = [...filteredPointers].reverse().slice(0, options.mediaLimit);
  const enrichedByMessageIndex = new Map<number, Record<string, unknown>>();

  for (const pointer of pointersToEnrich) {
    if (pointer.kind === "image") {
      const downloaded = await downloadImageMessage(port, chatName, chatIndex, options.direction, {
        chatKey,
        imageIndex: pointer.mediaIndex,
      });
      const imageDescription = options.includeImageDescriptions
        ? await describeImageFile(downloaded.path, options.prompt)
        : undefined;
      enrichedByMessageIndex.set(pointer.messageIndex, {
        kind: "image",
        imageIndex: pointer.mediaIndex,
        image: downloaded,
        imageDescription,
      });
      continue;
    }

    if (options.includeTranscriptions) {
      try {
        const transcribed = await transcribeLatestVoiceNote(
          port,
          chatName,
          chatIndex,
          {
            language: options.language,
            model: options.model,
            beamSize: options.beamSize,
            device: options.device,
            computeType: options.computeType,
          },
          options.direction,
          { chatKey, voiceNoteIndex: pointer.mediaIndex },
        );
        enrichedByMessageIndex.set(pointer.messageIndex, {
          kind: "voice_note",
          voiceNoteIndex: pointer.mediaIndex,
          voiceNote: transcribed,
        });
        continue;
      } catch (error) {
        const downloaded = await downloadLatestVoiceNote(port, chatName, chatIndex, options.direction, {
          chatKey,
          voiceNoteIndex: pointer.mediaIndex,
        });
        enrichedByMessageIndex.set(pointer.messageIndex, {
          kind: "voice_note",
          voiceNoteIndex: pointer.mediaIndex,
          voiceNote: downloaded,
          transcription: {
            available: false,
            detail: error instanceof Error ? error.message : String(error),
          },
        });
        continue;
      }
    }

    const downloaded = await downloadLatestVoiceNote(port, chatName, chatIndex, options.direction, {
      chatKey,
      voiceNoteIndex: pointer.mediaIndex,
    });
    enrichedByMessageIndex.set(pointer.messageIndex, {
      kind: "voice_note",
      voiceNoteIndex: pointer.mediaIndex,
      voiceNote: downloaded,
    });
  }

  const items = messages.map((message, messageIndex) => {
    const enriched = enrichedByMessageIndex.get(messageIndex);
    const pointer = pointers.find((candidate) => candidate.messageIndex === messageIndex);
    return {
      ...message,
      mediaPointer: pointer
        ? {
            kind: pointer.kind,
            mediaIndex: pointer.mediaIndex,
          }
        : undefined,
      enriched,
    };
  });

  return {
    ok: true,
    chatName,
    chatKey: chatKey ?? null,
    messageCount: messages.length,
    mediaCount: pointers.length,
    enrichedMediaCount: pointersToEnrich.length,
    ...summarizeTimelineMessages(messages),
    items,
  };
}

async function replyWithContext(
  port: number,
  chatName: string,
  chatIndex: number | undefined,
  chatKey: string | undefined,
  options: {
    mode: "suggest" | "send";
    tone: "neutral" | "warm" | "brief" | "supportive";
    alternativeIndex?: number;
    draftSignature?: string;
    selectedReply?: string;
    maxLength: number;
    messageLimit: number;
    mediaLimit: number;
    includeTranscriptions: boolean;
    includeImageDescriptions: boolean;
    direction: "in" | "out" | "any";
    prompt?: string;
    language?: string;
    model?: string;
    beamSize?: number;
    device?: string;
    computeType?: string;
  },
) {
  const timeline = await getChatTimelineSummary(port, chatName, chatIndex, chatKey, {
    messageLimit: options.messageLimit,
    mediaLimit: options.mediaLimit,
    includeTranscriptions: options.includeTranscriptions,
    includeImageDescriptions: options.includeImageDescriptions,
    direction: options.direction,
    prompt: options.prompt,
    language: options.language,
    model: options.model,
    beamSize: options.beamSize,
    device: options.device,
    computeType: options.computeType,
  });

  const draft = buildReplyDraftFromTimeline(timeline.items, {
    tone: options.tone,
    maxLength: options.maxLength,
    summary: timeline.summary,
    highlights: timeline.highlights,
    maxAlternatives: MAX_REPLY_DRAFT_ALTERNATIVES,
  });
  const selected = resolveReplySelection(draft, {
    alternativeIndex: options.alternativeIndex,
    draftSignature: options.draftSignature,
    selectedReply: options.selectedReply,
  });
  const suggestedReply = selected.selectedReply;

  if (options.mode === "send") {
    await sendMessage(port, chatName, suggestedReply, chatIndex, { chatKey });
  }

  return {
    ok: true,
    mode: options.mode,
    sent: options.mode === "send",
    chatName,
    chatKey: chatKey ?? null,
    suggestedReply,
    draftSignature: draft.draftSignature,
    selectedSource: selected.selectedSource,
    selectedAlternativeIndex: selected.selectedAlternativeIndex,
    selectedOptionId: selected.selectedOptionId,
    draft,
    timeline,
  };
}

function buildReviewTokenContextOptions(options: {
  tone: "neutral" | "warm" | "brief" | "supportive";
  maxLength: number;
  messageLimit: number;
  mediaLimit: number;
  includeTranscriptions: boolean;
  includeImageDescriptions: boolean;
  direction: "in" | "out" | "any";
  prompt?: string;
  language?: string;
  model?: string;
  beamSize?: number;
  device?: string;
  computeType?: string;
}): ReviewTokenContextOptions {
  return {
    tone: options.tone,
    maxLength: options.maxLength,
    messageLimit: options.messageLimit,
    mediaLimit: options.mediaLimit,
    includeTranscriptions: options.includeTranscriptions,
    includeImageDescriptions: options.includeImageDescriptions,
    direction: options.direction,
    prompt: options.prompt,
    language: options.language,
    model: options.model,
    beamSize: options.beamSize,
    device: options.device,
    computeType: options.computeType,
  };
}

async function reviewAndSendReply(
  port: number,
  chatName: string,
  chatIndex: number | undefined,
  chatKey: string | undefined,
  options: ReviewTokenContextOptions & { ttlSeconds: number },
) {
  const drafted = await draftReplyWithMediaContext(port, chatName, chatIndex, chatKey, options);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + options.ttlSeconds * 1000);
  const reviewToken = createReviewToken();

  await saveReviewToken({
    reviewToken,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    chatName,
    chatKey,
    chatIndex,
    draftSignature: drafted.draft.draftSignature,
    defaultOptionId: drafted.draft.recommendedOptionId,
    options: buildReviewTokenContextOptions(options),
  });

  return {
    ok: true,
    sent: false,
    reviewToken,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    chatName,
    chatKey: chatKey ?? null,
    sendable: drafted.draft.sendable,
    recommendedReply: drafted.draft.recommendedReply,
    recommendedOptionId: drafted.draft.recommendedOptionId,
    alternatives: drafted.draft.alternatives,
    contextSummary: drafted.draft.reasoningSummary,
    basedOn: drafted.draft.basedOn,
    draftSignature: drafted.draft.draftSignature,
    draft: drafted.draft,
    timeline: drafted.timeline,
  };
}

async function confirmReviewedReply(
  port: number,
  reviewToken: string,
  optionId: string | undefined,
) {
  const stored = await loadReviewToken(reviewToken);
  if (!stored) {
    throw new Error("review_token invalido o expirado. Vuelve a generar la revision.");
  }

  const expiresAtMs = Date.parse(stored.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    await deleteReviewToken(reviewToken);
    throw new Error("review_token expirado. Vuelve a generar la revision antes de enviar.");
  }

  const timeline = await getChatTimelineSummary(port, stored.chatName, stored.chatIndex, stored.chatKey, {
    messageLimit: stored.options.messageLimit,
    mediaLimit: stored.options.mediaLimit,
    includeTranscriptions: stored.options.includeTranscriptions,
    includeImageDescriptions: stored.options.includeImageDescriptions,
    direction: stored.options.direction,
    prompt: stored.options.prompt,
    language: stored.options.language,
    model: stored.options.model,
    beamSize: stored.options.beamSize,
    device: stored.options.device,
    computeType: stored.options.computeType,
  });

  const draft = buildReplyDraftFromTimeline(timeline.items, {
    tone: stored.options.tone,
    maxLength: stored.options.maxLength,
    summary: timeline.summary,
    highlights: timeline.highlights,
    maxAlternatives: MAX_REPLY_DRAFT_ALTERNATIVES,
  });

  const selected = resolveReplySelection(draft, {
    draftSignature: stored.draftSignature,
    optionId: optionId ?? stored.defaultOptionId,
  });

  await sendMessage(port, stored.chatName, selected.selectedReply, stored.chatIndex, { chatKey: stored.chatKey });
  await deleteReviewToken(reviewToken);

  return {
    ok: true,
    sent: true,
    reviewToken,
    chatName: stored.chatName,
    chatKey: stored.chatKey ?? null,
    suggestedReply: selected.selectedReply,
    selectedSource: selected.selectedSource,
    selectedAlternativeIndex: selected.selectedAlternativeIndex,
    selectedOptionId: selected.selectedOptionId,
    draftSignature: draft.draftSignature,
    timeline,
  };
}

async function draftReplyWithMediaContext(
  port: number,
  chatName: string,
  chatIndex: number | undefined,
  chatKey: string | undefined,
  options: {
    tone: "neutral" | "warm" | "brief" | "supportive";
    maxLength: number;
    messageLimit: number;
    mediaLimit: number;
    includeTranscriptions: boolean;
    includeImageDescriptions: boolean;
    direction: "in" | "out" | "any";
    prompt?: string;
    language?: string;
    model?: string;
    beamSize?: number;
    device?: string;
    computeType?: string;
  },
) {
  const timeline = await getChatTimelineSummary(port, chatName, chatIndex, chatKey, {
    messageLimit: options.messageLimit,
    mediaLimit: options.mediaLimit,
    includeTranscriptions: options.includeTranscriptions,
    includeImageDescriptions: options.includeImageDescriptions,
    direction: options.direction,
    prompt: options.prompt,
    language: options.language,
    model: options.model,
    beamSize: options.beamSize,
    device: options.device,
    computeType: options.computeType,
  });

  return {
    ok: true,
    chatName,
    chatKey: chatKey ?? null,
    draft: buildReplyDraftFromTimeline(timeline.items, {
      tone: options.tone,
      maxLength: options.maxLength,
      summary: timeline.summary,
      highlights: timeline.highlights,
      maxAlternatives: MAX_REPLY_DRAFT_ALTERNATIVES,
    }),
    timeline,
  };
}

function countExactTitleMatches(chats: Awaited<ReturnType<typeof searchChats>>, query: string): number {
  const normalized = query.trim().toLowerCase();
  return chats.filter((chat) => chat.title.trim().toLowerCase() === normalized).length;
}

function formatResolvedChats(
  visibleMatches: Awaited<ReturnType<typeof searchChats>>,
  query: string,
  allMatches = visibleMatches,
): string {
  if (!allMatches.length) return `No se encontraron chats para "${query}".`;
  const exactTitleMatchCount = countExactTitleMatches(allMatches, query);
  return JSON.stringify({
    query,
    count: visibleMatches.length,
    candidate_count: allMatches.length,
    disambiguation_needed: allMatches.length > 1,
    exact_title_match_count: exactTitleMatchCount,
    matches: visibleMatches.map((chat) => ({
      index: chat.index,
      chat_key: chat.chatKey,
      title: chat.title,
      unread: chat.unreadCount,
      selected: chat.selected,
      preview: chat.lastMessagePreview,
      match_reason: chat.matchReason,
    })),
  }, null, 2);
}

function formatChatContext(payload: {
  query?: string;
  resolved?: {
    chat_key: string;
    title: string;
    index?: number;
    preview?: string;
    match_reason?: string;
  };
  disambiguation_needed?: boolean;
  exact_title_match_count?: number;
  messages: Awaited<ReturnType<typeof readMessages>>;
}): string {
  return JSON.stringify(payload, null, 2);
}

const server = new Server(
  { name: "whatsapp-web-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "auto_auth_whatsapp_web",
      description:
        "Conecta o lanza Chrome con CDP para abrir WhatsApp Web y esperar a que la sesion quede autenticada.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["connect", "launch"], default: "connect" },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
          wait_for_login_seconds: { type: "number", default: 60 },
          chrome_path: { type: "string" },
          user_data_dir: { type: "string" },
          profile_directory: { type: "string" },
        },
        required: [],
      },
    },
    {
      name: "wait_for_activity_event",
      description: "Espera hasta que WhatsApp Web detecte un nuevo mensaje entrante o un cambio en chats no leidos, o hasta agotar el timeout.",
      inputSchema: {
        type: "object",
        properties: {
          timeout_ms: { type: "number", default: 300000 },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "check_auth",
      description: "Verifica si WhatsApp Web ya esta autenticado o si sigue esperando QR.",
      inputSchema: {
        type: "object",
        properties: {
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "list_chats",
      description: "Lista los chats visibles en la barra lateral de WhatsApp Web.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", default: 30 },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "list_unread_chats",
      description: "Lista solo los chats visibles con mensajes no leidos.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", default: 20 },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "search_chats",
      description: "Usa el buscador de WhatsApp Web para encontrar chats o contactos visibles por texto.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", default: 20 },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: ["query"],
      },
    },
    {
      name: "resolve_chat",
      description: "Resuelve uno o varios chats candidatos a partir de texto y devuelve chat_key para operar luego sobre la UI visible.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", default: 10 },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: ["query"],
      },
    },
    {
      name: "get_chat_context",
      description: "Resuelve un chat por query, chat_name o chat_key y devuelve contexto reciente listo para usar por un agente.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Texto para resolver el chat si aun no tienes chat_key." },
          chat_name: { type: "string" },
          chat_key: { type: "string" },
          preferred_chat_key: { type: "string", description: "Si viene, prioriza este candidato dentro de los resultados de resolucion." },
          exact_match: { type: "boolean", description: "Si es true, prioriza coincidencia exacta por titulo antes de usar el primer resultado." },
          chat_index: { type: "number", description: "Indice 1-based si hay chats repetidos con el mismo nombre." },
          limit: { type: "number", default: 12 },
          message_limit: { type: "number", description: "Cantidad de mensajes recientes a devolver. Si no viene, usa limit o 12." },
          candidate_limit: { type: "number", description: "Cantidad de candidatos a inspeccionar para detectar ambiguedad. Si no viene, usa una ventana interna mas amplia que limit." },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "clear_search",
      description: "Limpia el texto actual del buscador principal de chats.",
      inputSchema: {
        type: "object",
        properties: {
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "apply_chat_filter",
      description: "Activa un filtro visible de la barra de chats, por ejemplo Todos, No leídos, Favoritos o Grupos.",
      inputSchema: {
        type: "object",
        properties: {
          filter_name: { type: "string" },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: ["filter_name"],
      },
    },
    {
      name: "open_chat_by_search",
      description: "Busca un chat por texto en el buscador y abre el resultado visible indicado.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          result_index: { type: "number", default: 1 },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: ["query"],
      },
    },
    {
      name: "read_chat_messages",
      description: "Abre un chat por nombre y devuelve los mensajes visibles mas recientes.",
      inputSchema: {
        type: "object",
        properties: {
          chat_name: { type: "string" },
          chat_index: { type: "number", description: "Si hay chats repetidos con el mismo nombre, usa el indice 1-based." },
          chat_key: { type: "string", description: "Clave operativa del chat si ya fue descubierta antes." },
          limit: { type: "number", default: 20 },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "send_message",
      description: "Abre un chat por nombre y envia un mensaje de texto.",
      inputSchema: {
        type: "object",
        properties: {
          chat_name: { type: "string" },
          chat_index: { type: "number" },
          chat_key: { type: "string", description: "Clave operativa del chat si ya fue descubierta antes." },
          text: { type: "string" },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: ["text"],
      },
    },
    {
      name: "open_chat_by_key",
      description: "Abre un chat por su chat_key previamente descubierto. Puede usar chat_name como fallback de busqueda si el chat no esta visible.",
      inputSchema: {
        type: "object",
        properties: {
          chat_key: { type: "string" },
          chat_name: { type: "string", description: "Texto de apoyo para fallback por busqueda si hace falta." },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: ["chat_key"],
      },
    },
    {
      name: "list_voice_notes",
      description: "Enumera notas de voz del historial cargado de un chat. #1 es la mas reciente encontrada, #2 la anterior, etc.",
      inputSchema: {
        type: "object",
        properties: {
          chat_name: { type: "string" },
          chat_index: { type: "number" },
          chat_key: { type: "string", description: "Clave operativa del chat si ya fue descubierta antes." },
          limit: { type: "number", default: 20 },
          direction: { type: "string", enum: ["in", "out", "any"], default: "any" },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "list_image_messages",
      description: "Enumera imagenes reales del historial de un chat recorriendo de forma acotada mensajes anteriores. Ignora emojis e imagenes inline pequenas. #1 es la mas reciente encontrada, #2 la anterior, etc.",
      inputSchema: {
        type: "object",
        properties: {
          chat_name: { type: "string" },
          chat_index: { type: "number" },
          chat_key: { type: "string", description: "Clave operativa del chat si ya fue descubierta antes." },
          limit: { type: "number", default: 20 },
          direction: { type: "string", enum: ["in", "out", "any"], default: "any" },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "download_image_message",
      description: "Descarga una imagen real del historial de un chat recorriendo de forma acotada mensajes anteriores. Ignora emojis e imagenes inline pequenas. Usa image_index=1 para la mas reciente, 2 para la anterior, etc.",
      inputSchema: {
        type: "object",
        properties: {
          chat_name: { type: "string" },
          chat_index: { type: "number" },
          chat_key: { type: "string", description: "Clave operativa del chat si ya fue descubierta antes." },
          image_index: { type: "number", default: 1, description: "Indice 1-based de la imagen contando desde la mas reciente del historial cargado." },
          direction: { type: "string", enum: ["in", "out", "any"], default: "any" },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "get_latest_media_summary",
      description: "Detecta el ultimo medio relevante del chat y devuelve un resumen enriquecido en una sola llamada. Si es imagen, la descarga. Si es nota de voz, puede transcribirla.",
      inputSchema: {
        type: "object",
        properties: {
          chat_name: { type: "string" },
          chat_index: { type: "number" },
          chat_key: { type: "string", description: "Clave operativa del chat si ya fue descubierta antes." },
          message_limit: { type: "number", default: 80, description: "Cantidad de mensajes recientes a inspeccionar para encontrar el ultimo medio." },
          direction: { type: "string", enum: ["in", "out", "any"], default: "any", description: "Filtro aplicado al enriquecimiento de imagenes/notas de voz." },
          include_transcription: { type: "boolean", default: false, description: "Si el ultimo medio es una nota de voz, intenta devolver tambien la transcripcion." },
          language: { type: "string", description: "Codigo de idioma opcional para transcripcion, por ejemplo es o en." },
          model: { type: "string", description: "Modelo faster-whisper opcional si se transcribe la nota de voz." },
          beam_size: { type: "number", default: 5 },
          device: { type: "string", description: "cpu o cuda." },
          compute_type: { type: "string", description: "int8, float16, int8_float16, etc." },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "describe_latest_image",
      description: "Descarga la imagen real mas reciente del chat y, si hay un worker visual configurado, devuelve tambien una descripcion automatica.",
      inputSchema: {
        type: "object",
        properties: {
          chat_name: { type: "string" },
          chat_index: { type: "number" },
          chat_key: { type: "string", description: "Clave operativa del chat si ya fue descubierta antes." },
          direction: { type: "string", enum: ["in", "out", "any"], default: "any" },
          prompt: { type: "string", description: "Instruccion opcional para guiar la descripcion visual." },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "get_chat_timeline_summary",
      description: "Devuelve una linea de tiempo reciente del chat con texto y enriquecimiento opcional de imagenes y notas de voz en orden cronologico.",
      inputSchema: {
        type: "object",
        properties: {
          chat_name: { type: "string" },
          chat_index: { type: "number" },
          chat_key: { type: "string", description: "Clave operativa del chat si ya fue descubierta antes." },
          message_limit: { type: "number", default: 30, description: "Cantidad de mensajes recientes a incluir en la linea de tiempo." },
          media_limit: { type: "number", default: 3, description: "Cantidad maxima de medios recientes a enriquecer dentro de la linea de tiempo." },
          direction: { type: "string", enum: ["in", "out", "any"], default: "any", description: "Filtro aplicado al enriquecimiento de imagenes/notas de voz." },
          include_transcriptions: { type: "boolean", default: false, description: "Si es true, intenta transcribir notas de voz enriquecidas." },
          include_image_descriptions: { type: "boolean", default: false, description: "Si es true, intenta describir visualmente imagenes enriquecidas." },
          prompt: { type: "string", description: "Instruccion opcional para guiar la descripcion visual." },
          language: { type: "string", description: "Codigo de idioma opcional para transcripcion, por ejemplo es o en." },
          model: { type: "string", description: "Modelo faster-whisper opcional para transcripcion." },
          beam_size: { type: "number", default: 5 },
          device: { type: "string", description: "cpu o cuda." },
          compute_type: { type: "string", description: "int8, float16, int8_float16, etc." },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "audit_conversations",
      description: "Audita conversaciones recientes para detectar chats con parones, preguntas abiertas o seguimientos pendientes sin enviar ningun mensaje.",
      inputSchema: {
        type: "object",
        properties: {
          profile: { type: "string", enum: ["generic", "sales"], default: "generic" },
          scope: { type: "string", enum: ["visible", "unread"], default: "unread" },
          query: { type: "string", description: "Si se envia, audita coincidencias de search_chats y desplaza el uso de scope." },
          chat_keys: { type: "array", items: { type: "string" }, description: "Lista explicita de chat_key a auditar. Tiene precedencia sobre query y scope." },
          max_chats: { type: "number", default: 20, description: "Cantidad maxima de chats a auditar en esta corrida." },
          message_limit: { type: "number", default: 20, description: "Cantidad de mensajes recientes a inspeccionar por chat." },
          stale_after_minutes: { type: "number", default: 30, description: "Umbral base para marcar conversaciones como estancadas." },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "conversation_attention_board",
      description: "Construye un tablero operativo a partir de la auditoria conversacional, agrupando chats por buckets accionables y top actions.",
      inputSchema: {
        type: "object",
        properties: {
          profile: { type: "string", enum: ["generic", "sales"], default: "generic" },
          scope: { type: "string", enum: ["visible", "unread"], default: "unread" },
          query: { type: "string", description: "Si se envia, construye el board sobre coincidencias de busqueda." },
          chat_keys: { type: "array", items: { type: "string" }, description: "Lista explicita de chat_key a incluir en el board. Tiene precedencia sobre query y scope." },
          max_chats: { type: "number", default: 20, description: "Cantidad maxima de chats a incluir en esta corrida." },
          message_limit: { type: "number", default: 20, description: "Cantidad de mensajes recientes a inspeccionar por chat." },
          stale_after_minutes: { type: "number", default: 30, description: "Umbral base para marcar conversaciones como estancadas." },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "reply_with_context",
      description: "Construye una respuesta sugerida a partir del contexto reciente del chat. Por defecto solo sugiere; tambien puede enviarla si mode=send.",
      inputSchema: {
        type: "object",
        properties: {
          chat_name: { type: "string" },
          chat_index: { type: "number" },
          chat_key: { type: "string", description: "Clave operativa del chat si ya fue descubierta antes." },
          mode: { type: "string", enum: ["suggest", "send"], default: "suggest" },
          tone: { type: "string", enum: ["neutral", "warm", "brief", "supportive"], default: "neutral" },
          alternative_index: { type: "number", maximum: MAX_REPLY_DRAFT_ALTERNATIVES, description: `Indice 1-based de alternatives[] que quieres usar en vez de recommendedReply. Maximo actual: ${MAX_REPLY_DRAFT_ALTERNATIVES}.` },
          draft_signature: { type: "string", description: "Firma del borrador revisado previamente. Requerida para garantizar que el contexto no cambio antes de enviar una alternativa o texto seleccionado." },
          selected_reply: { type: "string", description: "Texto exacto revisado previamente. Si se envia junto con draft_signature, el servidor valida que siga perteneciendo al borrador actual antes de usarlo." },
          max_length: { type: "number", default: 240, description: "Longitud maxima sugerida para la respuesta." },
          message_limit: { type: "number", default: 20, description: "Cantidad de mensajes recientes a inspeccionar." },
          media_limit: { type: "number", default: 2, description: "Cantidad maxima de medios recientes a enriquecer para construir la respuesta." },
          include_transcriptions: { type: "boolean", default: false, description: "Si es true, intenta transcribir notas de voz para construir mejor la respuesta." },
          include_image_descriptions: { type: "boolean", default: false, description: "Si es true, intenta describir visualmente imagenes para construir mejor la respuesta." },
          direction: { type: "string", enum: ["in", "out", "any"], default: "any" },
          prompt: { type: "string", description: "Instruccion opcional para guiar la descripcion visual." },
          language: { type: "string", description: "Codigo de idioma opcional para transcripcion." },
          model: { type: "string", description: "Modelo faster-whisper opcional para transcripcion." },
          beam_size: { type: "number", default: 5 },
          device: { type: "string", description: "cpu o cuda." },
          compute_type: { type: "string", description: "int8, float16, int8_float16, etc." },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "draft_reply_with_media_context",
      description: "Construye un borrador enriquecido de respuesta con recomendacion, alternativas, trazabilidad y contexto multimedia reciente del chat.",
      inputSchema: {
        type: "object",
        properties: {
          chat_name: { type: "string" },
          chat_index: { type: "number" },
          chat_key: { type: "string", description: "Clave operativa del chat si ya fue descubierta antes." },
          tone: { type: "string", enum: ["neutral", "warm", "brief", "supportive"], default: "neutral" },
          max_length: { type: "number", default: 240, description: "Longitud maxima aproximada del borrador recomendado." },
          message_limit: { type: "number", default: 20, description: "Cantidad de mensajes recientes a inspeccionar." },
          media_limit: { type: "number", default: 2, description: "Cantidad maxima de medios recientes a enriquecer para construir el borrador." },
          include_transcriptions: { type: "boolean", default: false, description: "Si es true, intenta transcribir notas de voz para enriquecer el borrador." },
          include_image_descriptions: { type: "boolean", default: false, description: "Si es true, intenta describir visualmente imagenes para enriquecer el borrador." },
          direction: { type: "string", enum: ["in", "out", "any"], default: "any" },
          prompt: { type: "string", description: "Instruccion opcional para guiar la descripcion visual." },
          language: { type: "string", description: "Codigo de idioma opcional para transcripcion." },
          model: { type: "string", description: "Modelo faster-whisper opcional para transcripcion." },
          beam_size: { type: "number", default: 5 },
          device: { type: "string", description: "cpu o cuda." },
          compute_type: { type: "string", description: "int8, float16, int8_float16, etc." },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "review_and_send_reply",
      description: "Genera un borrador revisable con reviewToken estable para confirmar el envio en una segunda llamada. No envia nada en esta primera llamada.",
      inputSchema: {
        type: "object",
        properties: {
          chat_name: { type: "string" },
          chat_index: { type: "number" },
          chat_key: { type: "string", description: "Clave operativa del chat si ya fue descubierta antes." },
          tone: { type: "string", enum: ["neutral", "warm", "brief", "supportive"], default: "neutral" },
          max_length: { type: "number", default: 240, description: "Longitud maxima aproximada del borrador recomendado." },
          message_limit: { type: "number", default: 20, description: "Cantidad de mensajes recientes a inspeccionar." },
          media_limit: { type: "number", default: 2, description: "Cantidad maxima de medios recientes a enriquecer para construir el borrador." },
          include_transcriptions: { type: "boolean", default: false, description: "Si es true, intenta transcribir notas de voz para enriquecer el borrador." },
          include_image_descriptions: { type: "boolean", default: false, description: "Si es true, intenta describir visualmente imagenes para enriquecer el borrador." },
          direction: { type: "string", enum: ["in", "out", "any"], default: "any" },
          prompt: { type: "string", description: "Instruccion opcional para guiar la descripcion visual." },
          language: { type: "string", description: "Codigo de idioma opcional para transcripcion." },
          model: { type: "string", description: "Modelo faster-whisper opcional para transcripcion." },
          beam_size: { type: "number", default: 5 },
          device: { type: "string", description: "cpu o cuda." },
          compute_type: { type: "string", description: "int8, float16, int8_float16, etc." },
          review_ttl_seconds: { type: "number", default: DEFAULT_REVIEW_TTL_SECONDS, description: `Vida util del reviewToken en segundos. Maximo: ${MAX_REVIEW_TTL_SECONDS}.` },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "review_reply_for_confirmation",
      description: "Alias recomendado de review_and_send_reply. Genera un borrador revisable con reviewToken estable y no envia nada todavia.",
      inputSchema: {
        type: "object",
        properties: {
          chat_name: { type: "string" },
          chat_index: { type: "number" },
          chat_key: { type: "string", description: "Clave operativa del chat si ya fue descubierta antes." },
          tone: { type: "string", enum: ["neutral", "warm", "brief", "supportive"], default: "neutral" },
          max_length: { type: "number", default: 240, description: "Longitud maxima aproximada del borrador recomendado." },
          message_limit: { type: "number", default: 20, description: "Cantidad de mensajes recientes a inspeccionar." },
          media_limit: { type: "number", default: 2, description: "Cantidad maxima de medios recientes a enriquecer para construir el borrador." },
          include_transcriptions: { type: "boolean", default: false, description: "Si es true, intenta transcribir notas de voz para enriquecer el borrador." },
          include_image_descriptions: { type: "boolean", default: false, description: "Si es true, intenta describir visualmente imagenes para enriquecer el borrador." },
          direction: { type: "string", enum: ["in", "out", "any"], default: "any" },
          prompt: { type: "string", description: "Instruccion opcional para guiar la descripcion visual." },
          language: { type: "string", description: "Codigo de idioma opcional para transcripcion." },
          model: { type: "string", description: "Modelo faster-whisper opcional para transcripcion." },
          beam_size: { type: "number", default: 5 },
          device: { type: "string", description: "cpu o cuda." },
          compute_type: { type: "string", description: "int8, float16, int8_float16, etc." },
          review_ttl_seconds: { type: "number", default: DEFAULT_REVIEW_TTL_SECONDS, description: `Vida util del reviewToken en segundos. Maximo: ${MAX_REVIEW_TTL_SECONDS}.` },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "confirm_reviewed_reply",
      description: "Confirma y envia una respuesta previamente revisada con reviewToken. Si el contexto cambio o el token expiro, falla en vez de enviar otra cosa.",
      inputSchema: {
        type: "object",
        properties: {
          review_token: { type: "string", description: "Token devuelto por review_and_send_reply." },
          option_id: { type: "string", description: "recommendedOptionId u optionId concreto a enviar. Si se omite, usa la recomendacion por defecto revisada." },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: ["review_token"],
      },
    },
    {
      name: "download_voice_note",
      description: "Abre un chat y descarga una nota de voz del historial a un archivo temporal local. Usa voice_note_index=1 para la mas reciente, 2 para la anterior, etc.",
      inputSchema: {
        type: "object",
        properties: {
          chat_name: { type: "string" },
          chat_index: { type: "number" },
          chat_key: { type: "string", description: "Clave operativa del chat si ya fue descubierta antes." },
          voice_note_index: { type: "number", default: 1, description: "Indice 1-based de la nota de voz contando desde la mas reciente del historial cargado." },
          direction: { type: "string", enum: ["in", "out", "any"], default: "any" },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "download_latest_voice_note",
      description: "Alias compatible de download_voice_note. Abre un chat y descarga una nota de voz del historial a un archivo temporal local.",
      inputSchema: {
        type: "object",
        properties: {
          chat_name: { type: "string" },
          chat_index: { type: "number" },
          chat_key: { type: "string", description: "Clave operativa del chat si ya fue descubierta antes." },
          voice_note_index: { type: "number", default: 1, description: "Indice 1-based de la nota de voz contando desde la mas reciente del historial cargado." },
          direction: { type: "string", enum: ["in", "out", "any"], default: "any" },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
        },
        required: [],
      },
    },
    {
      name: "transcribe_voice_note",
      description: "Descarga una nota de voz del historial de un chat y la transcribe usando un worker local de faster-whisper. Usa voice_note_index=1 para la mas reciente, 2 para la anterior, etc.",
      inputSchema: {
        type: "object",
        properties: {
          chat_name: { type: "string" },
          chat_index: { type: "number" },
          chat_key: { type: "string", description: "Clave operativa del chat si ya fue descubierta antes." },
          voice_note_index: { type: "number", default: 1, description: "Indice 1-based de la nota de voz contando desde la mas reciente del historial cargado." },
          direction: { type: "string", enum: ["in", "out", "any"], default: "any" },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
          language: { type: "string", description: "Codigo de idioma opcional, por ejemplo es o en." },
          model: { type: "string", description: "Modelo faster-whisper, por ejemplo small, medium o large-v3." },
          beam_size: { type: "number", default: 5 },
          device: { type: "string", description: "cpu o cuda." },
          compute_type: { type: "string", description: "int8, float16, int8_float16, etc." },
        },
        required: [],
      },
    },
    {
      name: "transcribe_latest_voice_note",
      description: "Alias compatible de transcribe_voice_note. Descarga una nota de voz del historial de un chat y la transcribe.",
      inputSchema: {
        type: "object",
        properties: {
          chat_name: { type: "string" },
          chat_index: { type: "number" },
          chat_key: { type: "string", description: "Clave operativa del chat si ya fue descubierta antes." },
          voice_note_index: { type: "number", default: 1, description: "Indice 1-based de la nota de voz contando desde la mas reciente del historial cargado." },
          direction: { type: "string", enum: ["in", "out", "any"], default: "any" },
          remote_debugging_port: { type: "number", default: DEFAULT_PORT },
          language: { type: "string", description: "Codigo de idioma opcional, por ejemplo es o en." },
          model: { type: "string", description: "Modelo faster-whisper, por ejemplo small, medium o large-v3." },
          beam_size: { type: "number", default: 5 },
          device: { type: "string", description: "cpu o cuda." },
          compute_type: { type: "string", description: "int8, float16, int8_float16, etc." },
        },
        required: [],
      },
    },
    {
      name: "get_server_info",
      description: "Devuelve la configuracion basica del servidor MCP de WhatsApp Web.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const a = (request.params.arguments ?? {}) as Record<string, unknown>;

  const port = requirePort(a.remote_debugging_port, DEFAULT_PORT);

  switch (name) {
    case "auto_auth_whatsapp_web": {
      const auth = await autoAuth({
        port,
        mode: (a.mode as "connect" | "launch" | undefined) ?? "connect",
        waitForLoginSeconds: requireBoundedInt(a.wait_for_login_seconds, "wait_for_login_seconds", 60, 1, 3600),
        chromePath: typeof a.chrome_path === "string" ? a.chrome_path : undefined,
        userDataDir: typeof a.user_data_dir === "string" ? a.user_data_dir : undefined,
        profileDirectory: typeof a.profile_directory === "string" ? a.profile_directory : undefined,
      });
      return text(JSON.stringify(auth, null, 2));
    }

    case "wait_for_activity_event": {
      const timeoutMs = requireBoundedInt(a.timeout_ms, "timeout_ms", 300000, 1000, 3600000);
      const activity = await waitForActivityEvent(port, timeoutMs);
      return text(activity ? JSON.stringify(activity, null, 2) : "Sin eventos durante el timeout.");
    }

    case "check_auth": {
      const auth = await checkAuth(port);
      return text(JSON.stringify(auth, null, 2));
    }

    case "list_chats": {
      const chats = await listChats(port, requireBoundedInt(a.limit, "limit", 30, 1, 200));
      return text(formatChats(chats));
    }

    case "list_unread_chats": {
      const chats = await listUnreadChats(port, requireBoundedInt(a.limit, "limit", 20, 1, 200));
      return text(formatChats(chats));
    }

    case "search_chats": {
      const results = await searchChats(
        port,
        requireNonEmptyString(a.query, "query"),
        requireBoundedInt(a.limit, "limit", 20, 1, 200)
      );
      return text(formatSearchResults(results));
    }

    case "resolve_chat": {
      const query = requireNonEmptyString(a.query, "query");
      const requestedLimit = requireBoundedInt(a.limit, "limit", 10, 1, 50);
      const allMatches = await searchChats(
        port,
        query,
        Math.min(50, Math.max(requestedLimit, 25))
      );
      return text(formatResolvedChats(allMatches.slice(0, requestedLimit), query, allMatches));
    }

    case "get_chat_context": {
      const explicitChatKey = optionalTrimmedString(a.chat_key);
      const explicitChatName = optionalTrimmedString(a.chat_name);
      const preferredChatKey = optionalTrimmedString(a.preferred_chat_key);
      const query = optionalTrimmedString(a.query);
      const exactMatch = Boolean(a.exact_match);
      const { candidateLimit, messageLimit } = requireSearchWindow(a, { candidateLimit: 25, messageLimit: 12 });
      const chatIndex = typeof a.chat_index === "number"
        ? requireBoundedInt(a.chat_index, "chat_index", a.chat_index, 1, 100)
        : undefined;

      let resolved: {
        chat_key: string;
        title: string;
        index?: number;
        preview?: string;
        match_reason?: string;
      } | undefined;

      if (explicitChatKey) {
        const chatName = explicitChatName || "";
        const messages = await readMessages(port, chatName, messageLimit, chatIndex, { chatKey: explicitChatKey });
        return text(formatChatContext({
          resolved: {
            chat_key: explicitChatKey,
            title: explicitChatName || explicitChatKey,
          },
          messages,
        }));
      }

      const resolutionQuery = query || explicitChatName;
      if (!resolutionQuery) {
        throw new Error("Debes enviar query, chat_name o chat_key.");
      }

      const results = await searchChats(
        port,
        resolutionQuery,
        candidateLimit
      );
      const exactTitleMatchCount = countExactTitleMatches(results, resolutionQuery);
      if (!results.length) {
        return text(formatChatContext({
          query: resolutionQuery,
          disambiguation_needed: false,
          exact_title_match_count: 0,
          messages: [],
        }));
      }

      let selected =
        (preferredChatKey
          ? results.find((chat) => chat.chatKey === preferredChatKey)
          : undefined) ??
        (exactMatch
          ? results.find((chat) => chat.title.trim().toLowerCase() === resolutionQuery.trim().toLowerCase())
          : undefined) ??
        (typeof chatIndex === "number" && chatIndex > 0
          ? results[chatIndex - 1] ?? results[0]
          : results[0]);

      resolved = {
        chat_key: selected.chatKey,
        title: selected.title,
        index: selected.index,
        preview: selected.lastMessagePreview,
        match_reason: selected.matchReason,
      };
      const messages = await readMessages(port, selected.title, messageLimit, undefined, { chatKey: selected.chatKey });
      return text(formatChatContext({
        query: resolutionQuery,
        resolved,
        disambiguation_needed: exactTitleMatchCount > 1 || results.length > 1,
        exact_title_match_count: exactTitleMatchCount,
        messages,
      }));
    }

    case "clear_search": {
      await clearSearch(port);
      return text("Buscador principal limpiado.");
    }

    case "apply_chat_filter": {
      const filterName = requireNonEmptyString(a.filter_name, "filter_name");
      await applyChatFilter(port, filterName);
      return text(`Filtro aplicado: "${filterName}".`);
    }

    case "open_chat_by_search": {
      const query = requireNonEmptyString(a.query, "query");
      const resultIndex = requireBoundedInt(a.result_index, "result_index", 1, 1, 100);
      await openChatBySearch(port, query, resultIndex);
      return text(`Chat abierto desde busqueda: "${query}".`);
    }

    case "read_chat_messages": {
      const { chatName, chatKey } = requireChatIdentifier(a);
      const limit = requireBoundedInt(a.limit, "limit", 20, 1, 500);
      const chatIndex = typeof a.chat_index === "number"
        ? requireBoundedInt(a.chat_index, "chat_index", a.chat_index, 1, 100)
        : undefined;
      const messages = await readMessages(port, chatName, limit, chatIndex, { chatKey });
      return text(formatMessages(messages));
    }

    case "send_message": {
      const { chatName, chatKey } = requireChatIdentifier(a);
      const body = requireNonEmptyString(a.text, "text");
      const chatIndex = typeof a.chat_index === "number"
        ? requireBoundedInt(a.chat_index, "chat_index", a.chat_index, 1, 100)
        : undefined;
      await sendMessage(port, chatName, body, chatIndex, { chatKey });
      return text(`Mensaje enviado a "${chatName}".`);
    }

    case "open_chat_by_key": {
      const chatKey = requireNonEmptyString(a.chat_key, "chat_key");
      const chatName = typeof a.chat_name === "string" ? a.chat_name.trim() : "";
      await readMessages(port, chatName, 1, undefined, { chatKey });
      return text(`Chat abierto por chat_key: "${chatKey}".`);
    }

    case "list_voice_notes": {
      const { chatName, chatKey } = requireChatIdentifier(a);
      const chatIndex = typeof a.chat_index === "number"
        ? requireBoundedInt(a.chat_index, "chat_index", a.chat_index, 1, 100)
        : undefined;
      const limit = requireBoundedInt(a.limit, "limit", 20, 1, 200);
      const direction = requireAllowedString(a.direction, "direction", ["in", "out", "any"]) as "in" | "out" | "any" | undefined;
      const notes = await listVoiceNotes(port, chatName, chatIndex, direction ?? "any", limit, { chatKey });
      return text(formatVoiceNotes(notes));
    }

    case "list_image_messages": {
      const { chatName, chatKey } = requireChatIdentifier(a);
      const chatIndex = typeof a.chat_index === "number"
        ? requireBoundedInt(a.chat_index, "chat_index", a.chat_index, 1, 100)
        : undefined;
      const limit = requireBoundedInt(a.limit, "limit", 20, 1, 200);
      const direction = requireAllowedString(a.direction, "direction", ["in", "out", "any"]) as "in" | "out" | "any" | undefined;
      const images = await listImageMessages(port, chatName, chatIndex, direction ?? "any", limit, { chatKey });
      return text(formatImages(images));
    }

    case "download_image_message": {
      const { chatName, chatKey } = requireChatIdentifier(a);
      const chatIndex = typeof a.chat_index === "number"
        ? requireBoundedInt(a.chat_index, "chat_index", a.chat_index, 1, 100)
        : undefined;
      const imageIndex = typeof a.image_index === "number"
        ? requireBoundedInt(a.image_index, "image_index", a.image_index, 1, 500)
        : 1;
      const direction = requireAllowedString(a.direction, "direction", ["in", "out", "any"]) as "in" | "out" | "any" | undefined;
      const downloaded = await downloadImageMessage(port, chatName, chatIndex, direction ?? "any", {
        chatKey,
        imageIndex,
      });
      return text(JSON.stringify(downloaded, null, 2));
    }

    case "get_latest_media_summary": {
      const { chatName, chatKey } = requireChatIdentifier(a);
      const chatIndex = typeof a.chat_index === "number"
        ? requireBoundedInt(a.chat_index, "chat_index", a.chat_index, 1, 100)
        : undefined;
      const messageLimit = requireBoundedInt(a.message_limit, "message_limit", 80, 1, 500);
      const direction = requireAllowedString(a.direction, "direction", ["in", "out", "any"]) as "in" | "out" | "any" | undefined;
      const beamSize = typeof a.beam_size === "number"
        ? requireBoundedInt(a.beam_size, "beam_size", a.beam_size, 1, 20)
        : undefined;
      const summary = await getLatestMediaSummary(port, chatName, chatIndex, chatKey, {
        messageLimit,
        includeTranscription: typeof a.include_transcription === "boolean" ? a.include_transcription : false,
        direction: direction ?? "any",
        language: typeof a.language === "string" ? a.language.trim() || undefined : undefined,
        model: requireAllowedString(a.model, "model", TRANSCRIPTION_MODELS),
        beamSize,
        device: requireAllowedString(a.device, "device", TRANSCRIPTION_DEVICES),
        computeType: requireAllowedString(a.compute_type, "compute_type", TRANSCRIPTION_COMPUTE_TYPES),
      });
      return text(JSON.stringify(summary, null, 2));
    }

    case "describe_latest_image": {
      const { chatName, chatKey } = requireChatIdentifier(a);
      const chatIndex = typeof a.chat_index === "number"
        ? requireBoundedInt(a.chat_index, "chat_index", a.chat_index, 1, 100)
        : undefined;
      const direction = requireAllowedString(a.direction, "direction", ["in", "out", "any"]) as "in" | "out" | "any" | undefined;
      const described = await describeLatestImage(port, chatName, chatIndex, chatKey, {
        direction: direction ?? "any",
        prompt: typeof a.prompt === "string" ? a.prompt.trim() || undefined : undefined,
      });
      return text(JSON.stringify(described, null, 2));
    }

    case "get_chat_timeline_summary": {
      const { chatName, chatKey } = requireChatIdentifier(a);
      const chatIndex = typeof a.chat_index === "number"
        ? requireBoundedInt(a.chat_index, "chat_index", a.chat_index, 1, 100)
        : undefined;
      const messageLimit = requireBoundedInt(a.message_limit, "message_limit", 30, 1, 500);
      const mediaLimit = requireBoundedInt(a.media_limit, "media_limit", 3, 0, 20);
      const direction = requireAllowedString(a.direction, "direction", ["in", "out", "any"]) as "in" | "out" | "any" | undefined;
      const beamSize = typeof a.beam_size === "number"
        ? requireBoundedInt(a.beam_size, "beam_size", a.beam_size, 1, 20)
        : undefined;
      const timeline = await getChatTimelineSummary(port, chatName, chatIndex, chatKey, {
        messageLimit,
        mediaLimit,
        includeTranscriptions: typeof a.include_transcriptions === "boolean" ? a.include_transcriptions : false,
        includeImageDescriptions: typeof a.include_image_descriptions === "boolean" ? a.include_image_descriptions : false,
        direction: direction ?? "any",
        prompt: typeof a.prompt === "string" ? a.prompt.trim() || undefined : undefined,
        language: typeof a.language === "string" ? a.language.trim() || undefined : undefined,
        model: requireAllowedString(a.model, "model", TRANSCRIPTION_MODELS),
        beamSize,
        device: requireAllowedString(a.device, "device", TRANSCRIPTION_DEVICES),
        computeType: requireAllowedString(a.compute_type, "compute_type", TRANSCRIPTION_COMPUTE_TYPES),
      });
      return text(JSON.stringify(timeline, null, 2));
    }

    case "audit_conversations": {
      const profile = requireAllowedString(a.profile, "profile", ["generic", "sales"]) as "generic" | "sales" | undefined;
      const scope = requireAllowedString(a.scope, "scope", ["visible", "unread"]) as "visible" | "unread" | undefined;
      const result = await auditConversations(port, {
        profile: profile ?? "generic",
        scope: scope ?? "unread",
        maxChats: requireBoundedInt(a.max_chats, "max_chats", 20, 1, 100),
        messageLimit: requireBoundedInt(a.message_limit, "message_limit", 20, 1, 100),
        staleAfterMinutes: requireBoundedInt(a.stale_after_minutes, "stale_after_minutes", 30, 1, 10080),
        query: typeof a.query === "string" ? a.query.trim() || undefined : undefined,
        chatKeys: Array.isArray(a.chat_keys)
          ? a.chat_keys
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
          : undefined,
      });
      return text(JSON.stringify(result, null, 2));
    }

    case "conversation_attention_board": {
      const profile = requireAllowedString(a.profile, "profile", ["generic", "sales"]) as "generic" | "sales" | undefined;
      const scope = requireAllowedString(a.scope, "scope", ["visible", "unread"]) as "visible" | "unread" | undefined;
      const board = await buildConversationAttentionBoardFromAudit(port, {
        profile: profile ?? "generic",
        scope: scope ?? "unread",
        maxChats: requireBoundedInt(a.max_chats, "max_chats", 20, 1, 100),
        messageLimit: requireBoundedInt(a.message_limit, "message_limit", 20, 1, 100),
        staleAfterMinutes: requireBoundedInt(a.stale_after_minutes, "stale_after_minutes", 30, 1, 10080),
        query: typeof a.query === "string" ? a.query.trim() || undefined : undefined,
        chatKeys: Array.isArray(a.chat_keys)
          ? a.chat_keys
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
          : undefined,
      });
      return text(JSON.stringify(board, null, 2));
    }

    case "reply_with_context": {
      const { chatName, chatKey } = requireChatIdentifier(a);
      const chatIndex = typeof a.chat_index === "number"
        ? requireBoundedInt(a.chat_index, "chat_index", a.chat_index, 1, 100)
        : undefined;
      const mode = requireAllowedString(a.mode, "mode", ["suggest", "send"]) as "suggest" | "send" | undefined;
      const tone = requireAllowedString(a.tone, "tone", ["neutral", "warm", "brief", "supportive"]) as "neutral" | "warm" | "brief" | "supportive" | undefined;
      const alternativeIndex = typeof a.alternative_index === "number"
        ? requireBoundedInt(a.alternative_index, "alternative_index", a.alternative_index, 1, MAX_REPLY_DRAFT_ALTERNATIVES)
        : undefined;
      const messageLimit = requireBoundedInt(a.message_limit, "message_limit", 20, 1, 500);
      const mediaLimit = requireBoundedInt(a.media_limit, "media_limit", 2, 0, 20);
      const maxLength = requireBoundedInt(a.max_length, "max_length", 240, 10, 1000);
      const direction = requireAllowedString(a.direction, "direction", ["in", "out", "any"]) as "in" | "out" | "any" | undefined;
      const beamSize = typeof a.beam_size === "number"
        ? requireBoundedInt(a.beam_size, "beam_size", a.beam_size, 1, 20)
        : undefined;
      const reply = await replyWithContext(port, chatName, chatIndex, chatKey, {
        mode: mode ?? "suggest",
        tone: tone ?? "neutral",
        alternativeIndex,
        draftSignature: typeof a.draft_signature === "string" ? a.draft_signature.trim() || undefined : undefined,
        selectedReply: typeof a.selected_reply === "string" ? a.selected_reply.trim() || undefined : undefined,
        maxLength,
        messageLimit,
        mediaLimit,
        includeTranscriptions: typeof a.include_transcriptions === "boolean" ? a.include_transcriptions : false,
        includeImageDescriptions: typeof a.include_image_descriptions === "boolean" ? a.include_image_descriptions : false,
        direction: direction ?? "any",
        prompt: typeof a.prompt === "string" ? a.prompt.trim() || undefined : undefined,
        language: typeof a.language === "string" ? a.language.trim() || undefined : undefined,
        model: requireAllowedString(a.model, "model", TRANSCRIPTION_MODELS),
        beamSize,
        device: requireAllowedString(a.device, "device", TRANSCRIPTION_DEVICES),
        computeType: requireAllowedString(a.compute_type, "compute_type", TRANSCRIPTION_COMPUTE_TYPES),
      });
      return text(JSON.stringify(reply, null, 2));
    }

    case "draft_reply_with_media_context": {
      const { chatName, chatKey } = requireChatIdentifier(a);
      const chatIndex = typeof a.chat_index === "number"
        ? requireBoundedInt(a.chat_index, "chat_index", a.chat_index, 1, 100)
        : undefined;
      const tone = requireAllowedString(a.tone, "tone", ["neutral", "warm", "brief", "supportive"]) as "neutral" | "warm" | "brief" | "supportive" | undefined;
      const messageLimit = requireBoundedInt(a.message_limit, "message_limit", 20, 1, 500);
      const mediaLimit = requireBoundedInt(a.media_limit, "media_limit", 2, 0, 20);
      const maxLength = requireBoundedInt(a.max_length, "max_length", 240, 10, 1000);
      const direction = requireAllowedString(a.direction, "direction", ["in", "out", "any"]) as "in" | "out" | "any" | undefined;
      const beamSize = typeof a.beam_size === "number"
        ? requireBoundedInt(a.beam_size, "beam_size", a.beam_size, 1, 20)
        : undefined;
      const draft = await draftReplyWithMediaContext(port, chatName, chatIndex, chatKey, {
        tone: tone ?? "neutral",
        maxLength,
        messageLimit,
        mediaLimit,
        includeTranscriptions: typeof a.include_transcriptions === "boolean" ? a.include_transcriptions : false,
        includeImageDescriptions: typeof a.include_image_descriptions === "boolean" ? a.include_image_descriptions : false,
        direction: direction ?? "any",
        prompt: typeof a.prompt === "string" ? a.prompt.trim() || undefined : undefined,
        language: typeof a.language === "string" ? a.language.trim() || undefined : undefined,
        model: requireAllowedString(a.model, "model", TRANSCRIPTION_MODELS),
        beamSize,
        device: requireAllowedString(a.device, "device", TRANSCRIPTION_DEVICES),
        computeType: requireAllowedString(a.compute_type, "compute_type", TRANSCRIPTION_COMPUTE_TYPES),
      });
      return text(JSON.stringify(draft, null, 2));
    }

    case "review_and_send_reply":
    case "review_reply_for_confirmation": {
      const { chatName, chatKey } = requireChatIdentifier(a);
      const chatIndex = typeof a.chat_index === "number"
        ? requireBoundedInt(a.chat_index, "chat_index", a.chat_index, 1, 100)
        : undefined;
      const tone = requireAllowedString(a.tone, "tone", ["neutral", "warm", "brief", "supportive"]) as "neutral" | "warm" | "brief" | "supportive" | undefined;
      const messageLimit = requireBoundedInt(a.message_limit, "message_limit", 20, 1, 500);
      const mediaLimit = requireBoundedInt(a.media_limit, "media_limit", 2, 0, 20);
      const maxLength = requireBoundedInt(a.max_length, "max_length", 240, 10, 1000);
      const direction = requireAllowedString(a.direction, "direction", ["in", "out", "any"]) as "in" | "out" | "any" | undefined;
      const beamSize = typeof a.beam_size === "number"
        ? requireBoundedInt(a.beam_size, "beam_size", a.beam_size, 1, 20)
        : undefined;
      const reviewed = await reviewAndSendReply(port, chatName, chatIndex, chatKey, {
        tone: tone ?? "neutral",
        maxLength,
        messageLimit,
        mediaLimit,
        includeTranscriptions: typeof a.include_transcriptions === "boolean" ? a.include_transcriptions : false,
        includeImageDescriptions: typeof a.include_image_descriptions === "boolean" ? a.include_image_descriptions : false,
        direction: direction ?? "any",
        prompt: typeof a.prompt === "string" ? a.prompt.trim() || undefined : undefined,
        language: typeof a.language === "string" ? a.language.trim() || undefined : undefined,
        model: requireAllowedString(a.model, "model", TRANSCRIPTION_MODELS),
        beamSize,
        device: requireAllowedString(a.device, "device", TRANSCRIPTION_DEVICES),
        computeType: requireAllowedString(a.compute_type, "compute_type", TRANSCRIPTION_COMPUTE_TYPES),
        ttlSeconds: requireBoundedInt(a.review_ttl_seconds, "review_ttl_seconds", DEFAULT_REVIEW_TTL_SECONDS, 30, MAX_REVIEW_TTL_SECONDS),
      });
      return text(JSON.stringify(reviewed, null, 2));
    }

    case "confirm_reviewed_reply": {
      const reviewToken = assertValidReviewToken(requireNonEmptyString(a.review_token, "review_token"));
      const optionId = typeof a.option_id === "string" ? a.option_id.trim() || undefined : undefined;
      const confirmed = await confirmReviewedReply(port, reviewToken, optionId);
      return text(JSON.stringify(confirmed, null, 2));
    }

    case "download_voice_note":
    case "download_latest_voice_note": {
      const { chatName, chatKey } = requireChatIdentifier(a);
      const chatIndex = typeof a.chat_index === "number"
        ? requireBoundedInt(a.chat_index, "chat_index", a.chat_index, 1, 100)
        : undefined;
      const voiceNoteIndex = typeof a.voice_note_index === "number"
        ? requireBoundedInt(a.voice_note_index, "voice_note_index", a.voice_note_index, 1, 500)
        : 1;
      const direction = requireAllowedString(a.direction, "direction", ["in", "out", "any"]) as "in" | "out" | "any" | undefined;
      const downloaded = await downloadLatestVoiceNote(port, chatName, chatIndex, direction ?? "any", {
        chatKey,
        voiceNoteIndex,
      });
      return text(JSON.stringify(downloaded, null, 2));
    }

    case "transcribe_voice_note":
    case "transcribe_latest_voice_note": {
      const { chatName, chatKey } = requireChatIdentifier(a);
      const chatIndex = typeof a.chat_index === "number"
        ? requireBoundedInt(a.chat_index, "chat_index", a.chat_index, 1, 100)
        : undefined;
      const beamSize = typeof a.beam_size === "number"
        ? requireBoundedInt(a.beam_size, "beam_size", a.beam_size, 1, 20)
        : undefined;
      const voiceNoteIndex = typeof a.voice_note_index === "number"
        ? requireBoundedInt(a.voice_note_index, "voice_note_index", a.voice_note_index, 1, 500)
        : 1;
      const direction = requireAllowedString(a.direction, "direction", ["in", "out", "any"]) as "in" | "out" | "any" | undefined;
      const transcribed = await transcribeLatestVoiceNote(port, chatName, chatIndex, {
        language: typeof a.language === "string" ? a.language.trim() || undefined : undefined,
        model: requireAllowedString(a.model, "model", TRANSCRIPTION_MODELS),
        beamSize,
        device: requireAllowedString(a.device, "device", TRANSCRIPTION_DEVICES),
        computeType: requireAllowedString(a.compute_type, "compute_type", TRANSCRIPTION_COMPUTE_TYPES),
      }, direction ?? "any", { chatKey, voiceNoteIndex });
      return text(JSON.stringify(transcribed, null, 2));
    }

    case "get_server_info": {
      return text(JSON.stringify({
        name: "whatsapp-web-mcp",
        version: "0.1.0",
        defaultPort: DEFAULT_PORT,
        tools: [
          "auto_auth_whatsapp_web",
          "wait_for_activity_event",
          "check_auth",
          "list_chats",
          "list_unread_chats",
          "search_chats",
          "resolve_chat",
          "get_chat_context",
          "clear_search",
          "apply_chat_filter",
          "open_chat_by_search",
          "open_chat_by_key",
          "read_chat_messages",
          "send_message",
          "list_image_messages",
          "download_image_message",
          "get_latest_media_summary",
          "describe_latest_image",
          "get_chat_timeline_summary",
          "audit_conversations",
          "conversation_attention_board",
          "reply_with_context",
          "draft_reply_with_media_context",
          "review_and_send_reply",
          "review_reply_for_confirmation",
          "confirm_reviewed_reply",
          "list_voice_notes",
          "download_voice_note",
          "download_latest_voice_note",
          "transcribe_voice_note",
          "transcribe_latest_voice_note",
          "get_server_info",
        ],
      }, null, 2));
    }

    default:
      throw new Error(`Tool desconocida: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
