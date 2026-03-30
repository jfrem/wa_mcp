import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildSearchInputSelector,
  matchesSearchResultsLabel,
  matchesVoiceNoteControlLabel,
} from "../dist/whatsapp-locators.js";
import { buildFallbackChatKey, buildTimelineMediaPointers, isLikelyRealMessageImage, pickLatestMediaMessage, pickLatestMediaPointer, selectBestAudioEvent } from "../dist/whatsapp.js";
import { describeImageFile } from "../dist/image-description.js";
import { selectAuditTargets } from "../dist/conversation-audit.js";
import { buildConversationAttentionBoard } from "../dist/conversation-attention-board.js";
import { analyzeGenericConversation } from "../dist/conversation-audit-signals.js";
import { applySalesProfile } from "../dist/conversation-audit-profiles.js";
import { summarizeTimelineMessages } from "../dist/timeline-summary.js";
import { suggestReplyFromTimeline } from "../dist/reply-suggestion.js";
import { buildConversationState } from "../dist/conversation-state/engine.js";
import { mapConversationScoreToPriority, scoreConversationState } from "../dist/conversation-state/scoring.js";
import { MAX_REPLY_DRAFT_ALTERNATIVES, buildReplyDraftFromTimeline, resolveReplySelection, selectReplyFromDraft } from "../dist/draft-reply.js";
import { assertValidReviewToken, createReviewToken, deleteReviewToken, loadReviewToken, resolveReviewTokenFile, saveReviewToken } from "../dist/review-token-store.js";
import { buildChatFilterCache, resolveProjectRelativePath, shouldHandleChatName } from "../dist/bot-config.js";
import { computeLoopBackoffMs } from "../dist/bot-runtime.js";
import { resolveResponderModulePath } from "../dist/bot-responder.js";
import { resolveHealthyProcess } from "../dist/bot-daemon-health.js";
import { cleanTmpDir, getTmpDirSummary } from "../dist/tmp-maintenance.js";
import { getActionableFeed, listActionStrategies } from "../dist/actions/action-engine.js";
import { unansweredMessageStrategy } from "../dist/actions/strategies/unanswered-message.js";
import { followUpSimpleStrategy } from "../dist/actions/strategies/follow-up-simple.js";

async function run(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function formatMetaMinutesAgo(minutesAgo, author = "test") {
  const date = new Date(Date.now() - minutesAgo * 60000);
  const pad = (value) => String(value).padStart(2, "0");
  return `[${pad(date.getHours())}:${pad(date.getMinutes())}, ${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}] ${author}: `;
}

await run("search input selector supports Spanish and English placeholders", () => {
  const selector = buildSearchInputSelector();
  assert.match(selector, /Buscar un chat o iniciar uno nuevo/);
  assert.match(selector, /Search or start new chat/);
});

await run("search results label matcher supports Spanish and English", () => {
  assert.equal(matchesSearchResultsLabel("Resultados de la búsqueda."), true);
  assert.equal(matchesSearchResultsLabel("Search results."), true);
  assert.equal(matchesSearchResultsLabel("Other grid"), false);
});

await run("voice note control matcher supports Spanish and English", () => {
  assert.equal(matchesVoiceNoteControlLabel("Reproducir mensaje de voz"), true);
  assert.equal(matchesVoiceNoteControlLabel("Play voice message"), true);
  assert.equal(matchesVoiceNoteControlLabel("Pause voice message"), true);
  assert.equal(matchesVoiceNoteControlLabel("Play video"), false);
});

await run("example bot config uses repo-root tmp paths", () => {
  const config = JSON.parse(readFileSync(new URL("../bot.config.example.json", import.meta.url), "utf8"));
  assert.equal(config.logFile, "tmp/bot-events.log");
  assert.equal(config.stateFile, "tmp/bot-state.json");
});

await run("README documents repo-root tmp config path", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /tmp\/bot\.config\.json/);
});

await run("reply_with_context MCP schema declares seed_reply", () => {
  const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(indexSource, /name:\s*"reply_with_context"[\s\S]*seed_reply:\s*\{\s*type:\s*"string"/);
});

await run("bot path resolver strips redundant project directory prefix from relative tmp paths", () => {
  const resolved = resolveProjectRelativePath(
    "C:\\Users\\USER\\Desktop\\whatsapp-web-mcp-server",
    "whatsapp-web-mcp-server/tmp/bot-events.log",
    "C:\\Users\\USER\\Desktop\\whatsapp-web-mcp-server\\tmp\\bot-events.log",
  );
  assert.equal(resolved, "tmp\\bot-events.log");
});

await run("fallback chat key is title-based and not index-based", () => {
  assert.equal(buildFallbackChatKey("Amor 🤍"), "volatile:title::Amor 🤍");
});

await run("audio event selector prefers blob voice media over static audio assets", () => {
  const selected = selectBestAudioEvent([
    {
      requestId: "1",
      url: "https://static.whatsapp.net/rsrc.php/yv/r/ze2kHBOq8T0.mp3",
      mimeType: "audio/mpeg",
      type: "Media",
    },
    {
      requestId: "2",
      url: "blob:https://web.whatsapp.com/real-voice-note",
      mimeType: "audio/ogg",
      type: "Media",
    },
  ]);
  assert.equal(selected?.requestId, "2");
});

await run("real image detector rejects tiny inline gif placeholders", () => {
  assert.equal(isLikelyRealMessageImage({
    src: "data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==",
    width: 1,
    height: 1,
    alt: "🥰",
    hasViewerAffordance: false,
  }), false);
});

await run("real image detector rejects emoji-sized inline assets without viewer affordance", () => {
  assert.equal(isLikelyRealMessageImage({
    src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ",
    width: 32,
    height: 32,
    alt: "🫣",
    hasViewerAffordance: false,
  }), false);
});

await run("real image detector accepts large blob-backed media", () => {
  assert.equal(isLikelyRealMessageImage({
    src: "blob:https://web.whatsapp.com/real-image",
    width: 720,
    height: 1280,
    alt: "",
    hasViewerAffordance: true,
  }), true);
});

await run("real image detector accepts large viewer-backed inline previews", () => {
  assert.equal(isLikelyRealMessageImage({
    src: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD",
    width: 300,
    height: 300,
    alt: "",
    hasViewerAffordance: true,
  }), true);
});

await run("latest media picker prefers the most recent media message", () => {
  const selected = pickLatestMediaMessage([
    { index: 1, direction: "in", text: "hola", meta: "" },
    { index: 2, direction: "in", text: "[Imagen]", meta: "", mediaKind: "image" },
    { index: 3, direction: "out", text: "ok", meta: "" },
    { index: 4, direction: "in", text: "[Nota de voz]", meta: "", mediaKind: "voice_note" },
  ]);
  assert.equal(selected?.mediaKind, "voice_note");
  assert.equal(selected?.index, 4);
});

await run("latest media pointer computes the type-specific index from the same message window", () => {
  const selected = pickLatestMediaPointer([
    { index: 1, direction: "in", text: "[Imagen]", meta: "", mediaKind: "image" },
    { index: 2, direction: "in", text: "hola", meta: "" },
    { index: 3, direction: "out", text: "[Imagen]", meta: "", mediaKind: "image" },
    { index: 4, direction: "in", text: "[Nota de voz]", meta: "", mediaKind: "voice_note" },
    { index: 5, direction: "out", text: "ok", meta: "" },
  ]);
  assert.equal(selected?.kind, "voice_note");
  assert.equal(selected?.mediaIndex, 1);
  assert.equal(selected?.message.index, 4);
});

await run("latest media pointer counts older images correctly when the newest media is an image", () => {
  const selected = pickLatestMediaPointer([
    { index: 1, direction: "in", text: "[Imagen]", meta: "", mediaKind: "image" },
    { index: 2, direction: "in", text: "[Nota de voz]", meta: "", mediaKind: "voice_note" },
    { index: 3, direction: "out", text: "texto", meta: "" },
    { index: 4, direction: "out", text: "[Imagen]", meta: "", mediaKind: "image" },
  ]);
  assert.equal(selected?.kind, "image");
  assert.equal(selected?.mediaIndex, 1);
  assert.equal(selected?.message.index, 4);
});

await run("latest media pointer respects direction filter when selecting media indexes", () => {
  const selected = pickLatestMediaPointer([
    { index: 1, direction: "in", text: "[Imagen]", meta: "", mediaKind: "image" },
    { index: 2, direction: "out", text: "[Imagen]", meta: "", mediaKind: "image" },
    { index: 3, direction: "in", text: "texto", meta: "" },
  ], "in");
  assert.equal(selected?.kind, "image");
  assert.equal(selected?.mediaIndex, 1);
  assert.equal(selected?.message.index, 1);
});

await run("image description helper degrades cleanly when no worker is configured", async () => {
  const previousWorker = process.env.WHATSAPP_IMAGE_DESCRIBE_SCRIPT;
  delete process.env.WHATSAPP_IMAGE_DESCRIBE_SCRIPT;

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "wa-mcp-image-test-"));
  const imagePath = path.join(tempDir, "sample.jpg");
  writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  try {
    const description = await describeImageFile(imagePath);
    assert.equal(description.available, false);
    assert.match(description.detail ?? "", /WHATSAPP_IMAGE_DESCRIBE_SCRIPT/);
  } finally {
    if (typeof previousWorker === "string") {
      process.env.WHATSAPP_IMAGE_DESCRIBE_SCRIPT = previousWorker;
    } else {
      delete process.env.WHATSAPP_IMAGE_DESCRIBE_SCRIPT;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

await run("timeline media pointers preserve chronological order with type-specific indexes", () => {
  const pointers = buildTimelineMediaPointers([
    { index: 1, direction: "in", text: "[Imagen]", meta: "", mediaKind: "image" },
    { index: 2, direction: "in", text: "hola", meta: "" },
    { index: 3, direction: "out", text: "[Nota de voz]", meta: "", mediaKind: "voice_note" },
    { index: 4, direction: "out", text: "[Imagen]", meta: "", mediaKind: "image" },
  ]);

  assert.deepEqual(
    pointers.map((pointer) => ({ kind: pointer.kind, mediaIndex: pointer.mediaIndex, messageIndex: pointer.messageIndex })),
    [
      { kind: "image", mediaIndex: 2, messageIndex: 0 },
      { kind: "voice_note", mediaIndex: 1, messageIndex: 2 },
      { kind: "image", mediaIndex: 1, messageIndex: 3 },
    ],
  );
});

await run("timeline media pointers apply direction filter before numbering media", () => {
  const pointers = buildTimelineMediaPointers([
    { index: 1, direction: "in", text: "[Imagen]", meta: "", mediaKind: "image" },
    { index: 2, direction: "out", text: "[Nota de voz]", meta: "", mediaKind: "voice_note" },
    { index: 3, direction: "in", text: "[Imagen]", meta: "", mediaKind: "image" },
  ], "in");

  assert.deepEqual(
    pointers.map((pointer) => ({ kind: pointer.kind, mediaIndex: pointer.mediaIndex, messageIndex: pointer.messageIndex })),
    [
      { kind: "image", mediaIndex: 2, messageIndex: 0 },
      { kind: "image", mediaIndex: 1, messageIndex: 2 },
    ],
  );
});

await run("timeline summary produces readable summary and highlights", () => {
  const summary = summarizeTimelineMessages([
    { direction: "in", text: "Te estan dibujando", mediaKind: "image" },
    { direction: "out", text: "Jajaja" },
    { direction: "in", text: "[Imagen]", mediaKind: "image" },
  ]);

  assert.match(summary.summary, /mensajes entrantes con texto/i);
  assert.match(summary.summary, /imagen\(es\) real\(es\)/i);
  assert.equal(summary.highlights.length >= 2, true);
});

await run("timeline summary strips media UI markers from outgoing highlight text", () => {
  const summary = summarizeTimelineMessages([
    { direction: "out", text: "🤍\nVideo\nExcelente" },
  ]);

  assert.match(summary.highlights[0] ?? "", /Excelente/);
  assert.doesNotMatch(summary.highlights[0] ?? "", /\bVideo\b/);
});

await run("generic conversation audit flags inbound open question as waiting on us", () => {
  const item = analyzeGenericConversation({
    chatName: "Cliente demo",
    chatKey: "volatile:title::Cliente demo",
    unreadCount: 2,
    staleAfterMinutes: 30,
    messages: [
      { index: 1, direction: "out", text: "Hola, cuentame", meta: formatMetaMinutesAgo(80) },
      { index: 2, direction: "in", text: "Todavia esta disponible?", meta: formatMetaMinutesAgo(47) },
    ],
  });

  assert.equal(item.waitingOn, "us");
  assert.equal(item.stallType, "open_question");
  assert.equal(item.priority, "high");
  assert.match(item.suggestedAction, /Responder la pregunta abierta/i);
});

await run("generic conversation audit detects unresolved outgoing promise", () => {
  const item = analyzeGenericConversation({
    chatName: "Cliente demo",
    chatKey: "volatile:title::Cliente demo",
    unreadCount: 0,
    staleAfterMinutes: 30,
    messages: [
      { index: 1, direction: "in", text: "Me compartes el link?", meta: formatMetaMinutesAgo(70) },
      { index: 2, direction: "out", text: "Claro, ya te paso el link", meta: formatMetaMinutesAgo(50) },
    ],
  });

  assert.equal(item.waitingOn, "them");
  assert.equal(item.stallType, "unresolved_promise");
  assert.equal(item.priority, "high");
  assert.match(item.signals.join(" "), /unresolved_promise/);
});

await run("generic conversation audit marks outbound latest message as waiting on them", () => {
  const item = analyzeGenericConversation({
    chatName: "Cliente demo",
    chatKey: "volatile:title::Cliente demo",
    unreadCount: 0,
    staleAfterMinutes: 30,
    messages: [
      { index: 1, direction: "in", text: "Perfecto", meta: formatMetaMinutesAgo(20) },
      { index: 2, direction: "out", text: "Quedo atento a tu confirmacion", meta: formatMetaMinutesAgo(10) },
    ],
  });

  assert.equal(item.waitingOn, "them");
  assert.equal(item.status, "healthy");
  assert.equal(item.priority, "low");
});

await run("audit target selection prioritizes explicit chat_keys over query and scope", () => {
  const selection = selectAuditTargets({
    maxChats: 5,
    scope: "unread",
    query: "cliente",
    chatKeys: ["key-2", "key-1"],
    visibleChats: [
      { index: 1, chatKey: "key-1", title: "Cliente A", unreadCount: 3, lastMessagePreview: "", selected: false },
      { index: 2, chatKey: "key-2", title: "Cliente B", unreadCount: 0, lastMessagePreview: "", selected: false },
    ],
    unreadChats: [
      { index: 1, chatKey: "key-3", title: "Cliente C", unreadCount: 2, lastMessagePreview: "", selected: false },
    ],
    searchResults: [
      { index: 1, chatKey: "key-4", title: "Cliente D", unreadCount: 1, lastMessagePreview: "", selected: false, matchReason: "visible-result" },
    ],
  });

  assert.equal(selection.scope, "chat_keys");
  assert.deepEqual(selection.warnings, []);
  assert.deepEqual(
    selection.targets.map((item) => ({ title: item.title, chatKey: item.chatKey })),
    [
      { title: "Cliente B", chatKey: "key-2" },
      { title: "Cliente A", chatKey: "key-1" },
    ],
  );
});

await run("audit target selection omits off-screen chat_keys with explicit warnings", () => {
  const selection = selectAuditTargets({
    maxChats: 5,
    scope: "visible",
    chatKeys: ["key-offscreen", "key-1"],
    visibleChats: [
      { index: 1, chatKey: "key-1", title: "Cliente A", unreadCount: 3, lastMessagePreview: "", selected: false },
    ],
    unreadChats: [],
    searchResults: [],
  });

  assert.equal(selection.scope, "chat_keys");
  assert.deepEqual(selection.targets.map((item) => item.chatKey), ["key-1"]);
  assert.match(selection.warnings.join(" "), /key-offscreen/);
});

await run("audit target selection uses query matches when no explicit chat_keys are provided", () => {
  const selection = selectAuditTargets({
    maxChats: 5,
    scope: "unread",
    query: "cliente",
    chatKeys: [],
    visibleChats: [],
    unreadChats: [
      { index: 1, chatKey: "key-3", title: "Cliente C", unreadCount: 2, lastMessagePreview: "", selected: false },
    ],
    searchResults: [
      { index: 1, chatKey: "key-4", title: "Cliente D", unreadCount: 1, lastMessagePreview: "", selected: false, matchReason: "visible-result" },
      { index: 2, chatKey: "key-5", title: "Cliente E", unreadCount: 0, lastMessagePreview: "", selected: false, matchReason: "visible-result" },
    ],
  });

  assert.equal(selection.scope, "query");
  assert.deepEqual(selection.warnings, []);
  assert.deepEqual(
    selection.targets.map((item) => item.chatKey),
    ["key-4", "key-5"],
  );
});

await run("conversation state computes shared waitingOn, idleMinutes and signals", () => {
  const state = buildConversationState({
    chatName: "Cliente demo",
    chatKey: "volatile:title::Cliente demo",
    unreadCount: 2,
    staleAfterMinutes: 30,
    now: Date.now(),
    messages: [
      { index: 1, direction: "out", text: "Hola, cuentame", meta: formatMetaMinutesAgo(80) },
      { index: 2, direction: "in", text: "Todavia esta disponible?", meta: formatMetaMinutesAgo(47) },
    ],
  });

  assert.equal(state.waitingOn, "us");
  assert.equal(state.idleMinutes !== null && state.idleMinutes >= 40, true);
  assert.equal(state.signals.some((signal) => signal.type === "open_question"), true);
  assert.equal(state.signals.some((signal) => signal.type === "awaiting_business_response"), true);
});

await run("conversation scoring maps shared signals to high priority when business owes a response", () => {
  const state = buildConversationState({
    chatName: "Cliente demo",
    chatKey: "volatile:title::Cliente demo",
    unreadCount: 2,
    staleAfterMinutes: 30,
    now: Date.now(),
    messages: [
      { index: 1, direction: "out", text: "Hola, cuentame", meta: formatMetaMinutesAgo(80) },
      { index: 2, direction: "in", text: "Todavia esta disponible?", meta: formatMetaMinutesAgo(47) },
    ],
  });
  const scored = scoreConversationState(state);

  assert.equal(scored.score >= 0.55, true);
  assert.equal(mapConversationScoreToPriority(scored.score), "high");
});

await run("conversation scoring keeps a healthy waiting-on-them chat at low priority", () => {
  const state = buildConversationState({
    chatName: "Cliente demo",
    chatKey: "volatile:title::Cliente demo",
    unreadCount: 0,
    staleAfterMinutes: 30,
    now: Date.now(),
    messages: [
      { index: 1, direction: "in", text: "Perfecto", meta: formatMetaMinutesAgo(20) },
      { index: 2, direction: "out", text: "Quedo atento a tu confirmacion", meta: formatMetaMinutesAgo(10) },
    ],
  });
  const scored = scoreConversationState(state);

  assert.equal(scored.score < 0.3, true);
  assert.equal(mapConversationScoreToPriority(scored.score), "low");
});

await run("follow-up scoring boost uses the shared stale_after_minutes threshold", () => {
  const state = buildConversationState({
    chatName: "Cliente demo",
    chatKey: "volatile:title::Cliente demo",
    unreadCount: 0,
    staleAfterMinutes: 30,
    now: Date.now(),
    messages: [
      { index: 1, direction: "in", text: "Perfecto, quedo atento", meta: formatMetaMinutesAgo(140) },
      { index: 2, direction: "out", text: "Quedo atento a tu confirmacion", meta: formatMetaMinutesAgo(100) },
    ],
  });
  const scored = scoreConversationState(state);
  const followUpPriority = followUpSimpleStrategy.detect({ conversationState: state })[0]?.priority ?? 0;

  assert.equal(scored.score >= 0.2, true);
  assert.equal(followUpPriority > scored.score + 0.1, true);
});

await run("action strategy registry exposes default strategies", () => {
  assert.deepEqual(listActionStrategies(), ["unanswered_message", "follow_up_simple"]);
});

await run("unanswered_message strategy detects latest inbound unattended message", () => {
  const actions = unansweredMessageStrategy.detect({
    conversationState: buildConversationState({
      chatName: "Cliente A",
      chatKey: "key-1",
      unreadCount: 2,
      staleAfterMinutes: 30,
      now: Date.now(),
      messages: [
        { index: 1, direction: "out", text: "Hola", meta: formatMetaMinutesAgo(110, "negocio") },
        { index: 2, direction: "in", text: "Todavia esta disponible?", meta: formatMetaMinutesAgo(40, "cliente") },
      ],
    }),
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "reply");
  assert.equal(actions[0]?.label, "Responder ahora");
  assert.equal(actions[0]?.priority >= 0 && actions[0]?.priority <= 1, true);
  assert.match(actions[0]?.reason ?? "", /sin respuesta|esperando/i);
  assert.match(actions[0]?.preview.text ?? "", /Todavia esta disponible/i);
});

await run("unanswered_message strategy ignores chats whose latest relevant message is outbound", () => {
  const actions = unansweredMessageStrategy.detect({
    conversationState: buildConversationState({
      chatName: "Cliente B",
      chatKey: "key-2",
      unreadCount: 0,
      staleAfterMinutes: 30,
      now: Date.now(),
      messages: [
        { index: 1, direction: "in", text: "Me compartes el precio?", meta: formatMetaMinutesAgo(180, "cliente") },
        { index: 2, direction: "out", text: "Claro, ya te paso el precio", meta: formatMetaMinutesAgo(170, "negocio") },
      ],
    }),
  });

  assert.equal(actions.length, 0);
});

await run("follow_up_simple strategy detects stale outbound waiting on customer", () => {
  const actions = followUpSimpleStrategy.detect({
    conversationState: buildConversationState({
      chatName: "Cliente C",
      chatKey: "key-3",
      unreadCount: 0,
      staleAfterMinutes: 30,
      now: Date.now(),
      messages: [
        { index: 1, direction: "in", text: "Me mandas el precio?", meta: formatMetaMinutesAgo(500, "cliente") },
        { index: 2, direction: "out", text: "Claro, ya te paso el precio", meta: formatMetaMinutesAgo(360, "negocio") },
      ],
    }),
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "follow_up");
  assert.equal(actions[0]?.label, "Hacer follow-up");
  assert.equal(actions[0]?.priority >= 0 && actions[0]?.priority <= 1, true);
  assert.match(actions[0]?.reason ?? "", /no respondio|reactivar/i);
});

await run("follow_up_simple strategy ignores chats with unread inbound activity", () => {
  const actions = followUpSimpleStrategy.detect({
    conversationState: buildConversationState({
      chatName: "Cliente D",
      chatKey: "key-4",
      unreadCount: 1,
      staleAfterMinutes: 30,
      now: Date.now(),
      messages: [
        { index: 1, direction: "out", text: "Quedo atento", meta: formatMetaMinutesAgo(400, "negocio") },
        { index: 2, direction: "in", text: "Hola?", meta: formatMetaMinutesAgo(120, "cliente") },
      ],
    }),
  });

  assert.equal(actions.length, 0);
});

await run("follow_up_simple strategy derives staleness threshold from shared conversation state", () => {
  const baseMessages = [
    { index: 1, direction: "in", text: "Me mandas el precio?", meta: formatMetaMinutesAgo(140, "cliente") },
    { index: 2, direction: "out", text: "Claro, ya te paso el precio", meta: formatMetaMinutesAgo(100, "negocio") },
  ];
  const eligibleState = buildConversationState({
    chatName: "Cliente follow-up",
    chatKey: "key-follow-up-1",
    unreadCount: 0,
    staleAfterMinutes: 30,
    now: Date.now(),
    messages: baseMessages,
  });
  const notYetStaleState = buildConversationState({
    chatName: "Cliente follow-up",
    chatKey: "key-follow-up-2",
    unreadCount: 0,
    staleAfterMinutes: 40,
    now: Date.now(),
    messages: baseMessages,
  });

  assert.equal(followUpSimpleStrategy.detect({ conversationState: eligibleState }).length, 1);
  assert.equal(followUpSimpleStrategy.detect({ conversationState: notYetStaleState }).length, 0);
});

await run("audit and reply actions stay aligned on a shared conversation state", () => {
  const conversationState = buildConversationState({
    chatName: "Cliente A",
    chatKey: "key-1",
    unreadCount: 2,
    staleAfterMinutes: 30,
    now: Date.now(),
    messages: [
      { index: 1, direction: "out", text: "Hola", meta: formatMetaMinutesAgo(110, "negocio") },
      { index: 2, direction: "in", text: "Todavia esta disponible?", meta: formatMetaMinutesAgo(40, "cliente") },
    ],
  });

  const auditItem = analyzeGenericConversation({
    chatName: conversationState.chatName,
    chatKey: conversationState.chatKey ?? undefined,
    unreadCount: conversationState.unreadCount,
    messages: conversationState.messages,
    staleAfterMinutes: conversationState.staleAfterMinutes,
  });
  const actions = unansweredMessageStrategy.detect({ conversationState });

  assert.equal(auditItem.waitingOn, "us");
  assert.equal(auditItem.priority, "high");
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "reply");
  assert.match(actions[0]?.reason ?? "", /sin respuesta|esperando/i);
});

await run("audit and get_actionable_feed stay aligned for stale follow-up eligibility", async () => {
  const messages = [
    { index: 1, direction: "in", text: "Perfecto, quedo atento", meta: formatMetaMinutesAgo(140, "cliente") },
    { index: 2, direction: "out", text: "Quedo atento a tu confirmacion", meta: formatMetaMinutesAgo(100, "negocio") },
  ];
  const auditItem = analyzeGenericConversation({
    chatName: "Cliente follow-up",
    chatKey: "key-follow-up-feed",
    unreadCount: 0,
    staleAfterMinutes: 30,
    messages,
  });
  const result = await getActionableFeed(9222, {
    limit: 5,
    strategies: ["follow_up_simple"],
    staleAfterMinutes: 30,
  }, {
    listChatsFn: async () => ([
      { index: 1, chatKey: "key-follow-up-feed", title: "Cliente follow-up", unreadCount: 0, lastMessagePreview: "Quedo atento a tu confirmacion", selected: false },
    ]),
    readMessagesFn: async () => messages,
    now: () => Date.now(),
  });

  assert.equal(auditItem.waitingOn, "them");
  assert.equal(auditItem.stallType, "waiting_on_them");
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0]?.actions[0]?.type, "follow_up");
});

await run("get_actionable_feed respects stale_after_minutes when evaluating follow-up actions", async () => {
  const result = await getActionableFeed(9222, {
    limit: 5,
    strategies: ["follow_up_simple"],
    staleAfterMinutes: 40,
  }, {
    listChatsFn: async () => ([
      { index: 1, chatKey: "key-follow-up-feed", title: "Cliente follow-up", unreadCount: 0, lastMessagePreview: "Quedo atento a tu confirmacion", selected: false },
    ]),
    readMessagesFn: async () => ([
      { index: 1, direction: "in", text: "Perfecto, quedo atento", meta: formatMetaMinutesAgo(140, "cliente") },
      { index: 2, direction: "out", text: "Quedo atento a tu confirmacion", meta: formatMetaMinutesAgo(100, "negocio") },
    ]),
    now: () => Date.now(),
  });

  assert.equal(result.data.length, 0);
});

await run("get_actionable_feed warns on unknown strategies and limits sorted results", async () => {
  const result = await getActionableFeed(9222, {
    limit: 1,
    messageLimit: 37,
    staleAfterMinutes: 30,
    strategies: ["unknown_strategy", "unanswered_message", "follow_up_simple"],
  }, {
    listChatsFn: async () => ([
      { index: 1, chatKey: "key-1", title: "Cliente A", unreadCount: 2, lastMessagePreview: "Todavia esta disponible?", selected: false },
      { index: 2, chatKey: "key-2", title: "Cliente B", unreadCount: 0, lastMessagePreview: "Te paso el precio", selected: false },
    ]),
    readMessagesFn: async (_port, chatName) => (
      chatName === "Cliente A"
        ? [
            { index: 1, direction: "out", text: "Hola", meta: formatMetaMinutesAgo(110, "negocio") },
            { index: 2, direction: "in", text: "Todavia esta disponible?", meta: formatMetaMinutesAgo(40, "cliente") },
          ]
        : [
            { index: 1, direction: "in", text: "Me mandas el precio?", meta: formatMetaMinutesAgo(500, "cliente") },
            { index: 2, direction: "out", text: "Claro, ya te paso el precio", meta: formatMetaMinutesAgo(360, "negocio") },
          ]
    ),
    now: () => Date.now(),
  });

  assert.equal(result.data.length, 1);
  assert.equal(result.meta.has_more, true);
  assert.match(result.warnings.join(" "), /unknown_strategy/);
  assert.equal(result.data[0]?.priority >= 0 && result.data[0]?.priority <= 1, true);
  assert.match(result.data[0]?.actions[0]?.actionId ?? "", /^[a-f0-9]{16}$/);
  assert.equal(typeof result.data[0]?.actions[0]?.chatKey, "string");
  assert.equal(typeof result.data[0]?.actions[0]?.type, "string");
  assert.equal(typeof result.data[0]?.actions[0]?.label, "string");
  assert.equal(typeof result.data[0]?.actions[0]?.reason, "string");
  assert.equal(typeof result.data[0]?.actions[0]?.strategy, "string");
  assert.equal(result.data[0]?.actions[0]?.recommendedTool, "review_reply_for_confirmation");
  assert.equal(result.data[0]?.actions[0]?.previewTool, "draft_reply_with_media_context");
  assert.equal(result.data[0]?.actions[0]?.confirmTool, "confirm_reviewed_reply");
  assert.equal(result.data[0]?.actions[0]?.executionMode, "review_then_confirm");
  assert.equal(typeof result.data[0]?.actions[0]?.preview?.text, "string");
  assert.equal(typeof result.data[0]?.actions[0]?.recommendedArgs?.chat_key, "string");
  assert.equal(typeof result.data[0]?.actions[0]?.previewArgs?.chat_key, "string");
  assert.equal(result.data[0]?.actions[0]?.recommendedArgs?.message_limit, 37);
  assert.equal(result.data[0]?.actions[0]?.previewArgs?.message_limit, 37);
  assert.equal(typeof result.data[0]?.actions[0]?.recommendedArgs?.review_ttl_seconds, "number");
  assert.equal(result.data[0]?.actions[0]?.requiresHumanReview, true);
  assert.equal(Array.isArray(result.data[0]?.actions[0]?.evidence), true);
});

await run("get_actionable_feed exposes the frozen minimum SuggestedAction contract", async () => {
  const result = await getActionableFeed(9222, {
    limit: 1,
    staleAfterMinutes: 30,
    strategies: ["unanswered_message"],
  }, {
    listChatsFn: async () => ([
      { index: 1, chatKey: "key-1", title: "Cliente A", unreadCount: 2, lastMessagePreview: "Todavia esta disponible?", selected: false },
    ]),
    readMessagesFn: async () => ([
      { index: 1, direction: "out", text: "Hola", meta: formatMetaMinutesAgo(110, "negocio") },
      { index: 2, direction: "in", text: "Todavia esta disponible?", meta: formatMetaMinutesAgo(40, "cliente") },
    ]),
    now: () => Date.now(),
  });

  const action = result.data[0]?.actions[0];
  assert.ok(action);
  assert.deepEqual(
    Object.keys(action).filter((key) => [
      "actionId",
      "chatKey",
      "type",
      "label",
      "priority",
      "reason",
      "preview",
      "strategy",
      "recommendedTool",
      "recommendedArgs",
      "executionMode",
      "requiresHumanReview",
    ].includes(key)).sort(),
    [
      "actionId",
      "chatKey",
      "executionMode",
      "label",
      "preview",
      "priority",
      "reason",
      "recommendedArgs",
      "recommendedTool",
      "requiresHumanReview",
      "strategy",
      "type",
    ],
  );
  assert.equal(action?.recommendedTool, "review_reply_for_confirmation");
  assert.notEqual(action?.recommendedTool, "send_message");
  assert.equal(action?.executionMode, "review_then_confirm");
  assert.equal(action?.requiresHumanReview, true);
});

await run("get_actionable_feed preserves follow-up intent in recommended execution args", async () => {
  const result = await getActionableFeed(9222, {
    limit: 5,
    strategies: ["follow_up_simple"],
    staleAfterMinutes: 30,
  }, {
    listChatsFn: async () => ([
      { index: 1, chatKey: "key-follow-up-seed", title: "Cliente follow-up", unreadCount: 0, lastMessagePreview: "Quedo atento a tu confirmacion", selected: false },
    ]),
    readMessagesFn: async () => ([
      { index: 1, direction: "in", text: "Perfecto, quedo atento", meta: formatMetaMinutesAgo(140, "cliente") },
      { index: 2, direction: "out", text: "Quedo atento a tu confirmacion", meta: formatMetaMinutesAgo(100, "negocio") },
    ]),
    now: () => Date.now(),
  });

  const action = result.data[0]?.actions[0];
  assert.equal(action?.type, "follow_up");
  assert.equal(action?.recommendedArgs?.seed_reply, action?.preview.text);
  assert.equal(action?.previewArgs?.seed_reply, action?.preview.text);
});

await run("get_actionable_feed preserves reply intent in recommended execution args", async () => {
  const result = await getActionableFeed(9222, {
    limit: 5,
    strategies: ["unanswered_message"],
    staleAfterMinutes: 30,
  }, {
    listChatsFn: async () => ([
      { index: 1, chatKey: "key-reply-seed", title: "Cliente reply", unreadCount: 1, lastMessagePreview: "Necesito ayuda urgente", selected: false },
    ]),
    readMessagesFn: async () => ([
      { index: 1, direction: "out", text: "Hola", meta: formatMetaMinutesAgo(120, "negocio") },
      { index: 2, direction: "in", text: "Necesito ayuda urgente con esto porque no me esta funcionando como esperaba", meta: formatMetaMinutesAgo(40, "cliente") },
    ]),
    now: () => Date.now(),
  });

  const action = result.data[0]?.actions[0];
  assert.equal(action?.type, "reply");
  assert.equal(action?.recommendedArgs?.seed_reply, action?.preview.text);
  assert.equal(action?.previewArgs?.seed_reply, action?.preview.text);
});

await run("get_actionable_feed prioritizes across all retrieved visible chats", async () => {
  const visibleChats = Array.from({ length: 40 }, (_, index) => ({
    index: index + 1,
    chatKey: `key-${index + 1}`,
    title: `Chat ${index + 1}`,
    unreadCount: 0,
    lastMessagePreview: "",
    selected: false,
  }));
  visibleChats[39] = {
    index: 40,
    chatKey: "key-40",
    title: "Chat 40",
    unreadCount: 2,
    lastMessagePreview: "Todavia esta disponible?",
    selected: false,
  };
  const result = await getActionableFeed(9222, {
    limit: 5,
    strategies: ["unanswered_message"],
    staleAfterMinutes: 30,
  }, {
    listChatsFn: async () => visibleChats,
    readMessagesFn: async (_port, chatName) => (
      chatName === "Chat 40"
        ? [
            { index: 1, direction: "out", text: "Hola", meta: formatMetaMinutesAgo(120, "negocio") },
            { index: 2, direction: "in", text: "Todavia esta disponible?", meta: formatMetaMinutesAgo(40, "cliente") },
          ]
        : [
            { index: 1, direction: "out", text: "Seguimos en contacto", meta: formatMetaMinutesAgo(20, "negocio") },
          ]
    ),
    now: () => Date.now(),
  });

  assert.equal(result.data.length, 1);
  assert.equal(result.data[0]?.chatId, "key-40");
});

await run("get_actionable_feed returns empty data when all requested strategies are unknown", async () => {
  const result = await getActionableFeed(9222, {
    staleAfterMinutes: 30,
    strategies: ["unknown_strategy"],
  }, {
    listChatsFn: async () => ([
      { index: 1, chatKey: "key-1", title: "Cliente A", unreadCount: 2, lastMessagePreview: "Todavia esta disponible?", selected: false },
    ]),
    readMessagesFn: async () => ([
      { index: 1, direction: "out", text: "Hola", meta: formatMetaMinutesAgo(110, "negocio") },
      { index: 2, direction: "in", text: "Todavia esta disponible?", meta: formatMetaMinutesAgo(40, "cliente") },
    ]),
    now: () => Date.now(),
  });

  assert.equal(result.data.length, 0);
  assert.equal(result.meta.has_more, false);
  assert.match(result.warnings.join(" "), /unknown_strategy/);
});

await run("sales profile upgrades high-intent inbound lead to high priority", () => {
  const messages = [
    { index: 1, direction: "out", text: "Hola, te ayudo", meta: formatMetaMinutesAgo(40) },
    { index: 2, direction: "in", text: "Como pago? pasame el link", meta: formatMetaMinutesAgo(22) },
  ];
  const generic = analyzeGenericConversation({
    chatName: "Lead demo",
    chatKey: "volatile:title::Lead demo",
    unreadCount: 1,
    staleAfterMinutes: 30,
    messages,
  });
  const sales = applySalesProfile(generic, messages);

  assert.equal(sales.priority, "high");
  assert.equal(sales.profileData?.salesSignal, "high");
  assert.equal(sales.profileData?.salesStage, "closing");
  assert.match(String(sales.suggestedAction), /cierre|link|pago/i);
});

await run("sales profile detects objection and marks objection stage", () => {
  const messages = [
    { index: 1, direction: "out", text: "Te comparto el precio", meta: formatMetaMinutesAgo(50) },
    { index: 2, direction: "in", text: "Esta muy caro, lo voy a pensar", meta: formatMetaMinutesAgo(35) },
  ];
  const generic = analyzeGenericConversation({
    chatName: "Lead demo",
    chatKey: "volatile:title::Lead demo",
    unreadCount: 1,
    staleAfterMinutes: 30,
    messages,
  });
  const sales = applySalesProfile(generic, messages);

  assert.equal(sales.profileData?.objectionDetected, true);
  assert.equal(sales.profileData?.salesStage, "objection");
  assert.match(String(sales.suggestedAction), /objecion|objeción|traccion|tracción/i);
});

await run("sales profile marks unresolved commercial promise as pending offer", () => {
  const messages = [
    { index: 1, direction: "in", text: "Me mandas el precio?", meta: formatMetaMinutesAgo(70) },
    { index: 2, direction: "out", text: "Claro, ya te paso el precio", meta: formatMetaMinutesAgo(55) },
  ];
  const generic = analyzeGenericConversation({
    chatName: "Lead demo",
    chatKey: "volatile:title::Lead demo",
    unreadCount: 0,
    staleAfterMinutes: 30,
    messages,
  });
  const sales = applySalesProfile(generic, messages);

  assert.equal(sales.profileData?.pendingCommercialPromise, true);
  assert.match(String(sales.suggestedAction), /prometido|precio/i);
  assert.match(sales.signals.join(" "), /sales_pending_offer/);
});

await run("sales profile does not keep stale high-intent signals after business already replied", () => {
  const messages = [
    { index: 1, direction: "in", text: "Como pago?", meta: formatMetaMinutesAgo(100) },
    { index: 2, direction: "out", text: "Ok", meta: formatMetaMinutesAgo(90) },
  ];
  const generic = analyzeGenericConversation({
    chatName: "Lead demo",
    chatKey: "volatile:title::Lead demo",
    unreadCount: 0,
    staleAfterMinutes: 30,
    messages,
  });
  const sales = applySalesProfile(generic, messages);

  assert.equal(sales.waitingOn, "them");
  assert.equal(sales.status, "healthy");
  assert.equal(sales.profileData?.salesSignal, "low");
  assert.doesNotMatch(sales.signals.join(" "), /sales_signal_high/);
  assert.doesNotMatch(String(sales.suggestedAction), /cierre|cerrar|pago|link/i);
});

await run("conversation attention board groups items into actionable buckets", () => {
  const board = buildConversationAttentionBoard({
    ok: true,
    profile: "sales",
    scope: "query",
    count: 3,
    warnings: [],
    items: [
      {
        chatName: "Lead caliente",
        chatKey: "k1",
        unreadCount: 1,
        priority: "high",
        status: "attention_needed",
        waitingOn: "us",
        stallType: "open_question",
        idleMinutes: 45,
        confidence: 0.9,
        signals: ["customer_question", "sales_signal_high"],
        lastRelevantMessage: "Como pago?",
        suggestedAction: "Responder ya",
        nextBestAction: "Cerrar",
        profileData: { salesSignal: "high" },
      },
      {
        chatName: "Promesa pendiente",
        chatKey: "k2",
        unreadCount: 0,
        priority: "high",
        status: "attention_needed",
        waitingOn: "them",
        stallType: "unresolved_promise",
        idleMinutes: 80,
        confidence: 0.88,
        signals: ["unresolved_promise", "sales_signal_medium"],
        lastRelevantMessage: "Ya te paso el precio",
        suggestedAction: "Cumplir promesa",
        nextBestAction: "Enviar precio",
        profileData: { salesSignal: "medium" },
      },
      {
        chatName: "Saludable",
        chatKey: "k3",
        unreadCount: 0,
        priority: "low",
        status: "healthy",
        waitingOn: "them",
        stallType: "waiting_on_them",
        idleMinutes: 10,
        confidence: 0.5,
        signals: [],
        lastRelevantMessage: "Ok",
        suggestedAction: "Monitorear",
      },
    ],
  });

  assert.equal(board.summary.totalChats, 3);
  assert.equal(board.summary.urgentNow, 1);
  assert.equal(board.summary.promisesToFulfill, 1);
  assert.equal(board.summary.healthy, 1);
  assert.equal(board.buckets.urgentNow[0]?.chatName, "Lead caliente");
  assert.equal(board.buckets.promisesToFulfill[0]?.chatName, "Promesa pendiente");
  assert.equal(board.buckets.healthy[0]?.chatName, "Saludable");
  assert.equal(board.topActions.length >= 2, true);
});

await run("conversation attention board stays aligned with an audited high-priority shared-state item", () => {
  const auditItem = analyzeGenericConversation({
    chatName: "Lead caliente",
    chatKey: "k-audit",
    unreadCount: 1,
    staleAfterMinutes: 30,
    messages: [
      { index: 1, direction: "out", text: "Hola, te ayudo", meta: formatMetaMinutesAgo(80) },
      { index: 2, direction: "in", text: "Como pago? pasame el link", meta: formatMetaMinutesAgo(45) },
    ],
  });
  const board = buildConversationAttentionBoard({
    ok: true,
    profile: "generic",
    scope: "visible",
    count: 1,
    warnings: [],
    items: [auditItem],
  });

  assert.equal(auditItem.priority, "high");
  assert.equal(auditItem.waitingOn, "us");
  assert.equal(board.summary.urgentNow, 1);
  assert.equal(board.buckets.urgentNow[0]?.chatKey, "k-audit");
  assert.equal(board.summary.monitoring, 0);
});

await run("conversation attention board keeps non-healthy uncategorized items in monitoring bucket", () => {
  const board = buildConversationAttentionBoard({
    ok: true,
    profile: "generic",
    scope: "visible",
    count: 1,
    warnings: [],
    items: [
      {
        chatName: "Seguimiento leve",
        chatKey: "k4",
        unreadCount: 0,
        priority: "medium",
        status: "watch",
        waitingOn: "unknown",
        stallType: "none",
        idleMinutes: 15,
        confidence: 0.52,
        signals: [],
        lastRelevantMessage: "Visto",
        suggestedAction: "Revisar mas tarde",
      },
    ],
  });

  assert.equal(board.summary.totalChats, 1);
  assert.equal(board.summary.monitoring, 1);
  assert.equal(board.buckets.monitoring[0]?.chatName, "Seguimiento leve");
});

await run("reply suggestion prioritizes the latest incoming meaningful text", () => {
  const suggestion = suggestReplyFromTimeline([
    { direction: "in", text: "Me ayudas con eso?" },
    { direction: "out", text: "Sí" },
    { direction: "in", text: "Necesito subir las imagenes" },
  ], { tone: "supportive", maxLength: 200 });

  assert.match(suggestion, /Necesito subir las imagenes/);
  assert.match(suggestion, /te ayudo/i);
});

await run("reply suggestion falls back to image acknowledgement when there is no meaningful text", () => {
  const suggestion = suggestReplyFromTimeline([
    { direction: "in", text: "[Imagen]", mediaKind: "image" },
  ], { tone: "neutral", maxLength: 200 });

  assert.match(suggestion, /imagen/i);
});

await run("reply suggestion prioritizes the latest incoming media over older incoming text", () => {
  const suggestion = suggestReplyFromTimeline([
    { direction: "in", text: "Te estan dibujando" },
    { direction: "in", text: "[Imagen]", mediaKind: "image" },
  ], { tone: "neutral", maxLength: 200 });

  assert.match(suggestion, /imagen/i);
  assert.doesNotMatch(suggestion, /Te estan dibujando/);
});

await run("reply draft builds recommended reply plus alternatives and based_on metadata", () => {
  const draft = buildReplyDraftFromTimeline([
    { direction: "in", text: "Necesito subir las imagenes" },
  ], {
    tone: "supportive",
    maxLength: 200,
    summary: "Hay 1 mensaje entrante con texto.",
    highlights: ["Ultimo mensaje recibido: Necesito subir las imagenes"],
  });

  assert.match(draft.recommendedReply, /Necesito subir las imagenes/);
  assert.match(draft.draftSignature, /^[a-f0-9]{16}$/);
  assert.equal(draft.alternatives.length >= 2, true);
  assert.equal(draft.basedOn.eventType, "text");
  assert.equal(draft.sendable, true);
  assert.match(draft.reasoningSummary, /mensaje entrante|prioriza/i);
});

await run("reply draft uses image metadata when latest inbound event is an image", () => {
  const draft = buildReplyDraftFromTimeline([
    {
      direction: "in",
      text: "[Imagen]",
      mediaKind: "image",
      enriched: {
        imageDescription: {
          description: "una captura con tres personas posando",
        },
      },
    },
  ], { tone: "neutral", maxLength: 200 });

  assert.equal(draft.basedOn.eventType, "image");
  assert.equal(draft.basedOn.usedImageDescription, true);
  assert.match(draft.recommendedReply, /imagen/i);
});

await run("reply draft preserves a provided seed reply as the recommended option", () => {
  const draft = buildReplyDraftFromTimeline([
    { direction: "in", text: "Perfecto, quedo atento" },
    { direction: "out", text: "Quedo atento a tu confirmacion" },
  ], {
    tone: "warm",
    maxLength: 240,
    seedReply: "Hola, Cliente follow-up. Retomo esta conversacion por aqui para ayudarte a cerrar el siguiente paso. Si quieres, te comparto el detalle ahora mismo.",
  });

  assert.match(draft.recommendedReply, /Retomo esta conversacion por aqui/i);
  assert.match(draft.reasoningSummary, /semilla de respuesta/i);
});

await run("reply draft can select a concrete alternative by 1-based index", () => {
  const draft = buildReplyDraftFromTimeline([
    { direction: "in", text: "Necesito subir las imagenes" },
  ], { tone: "neutral", maxLength: 200 });

  const selected = selectReplyFromDraft(draft, 1);
  assert.equal(selected.selectedSource, "alternative");
  assert.equal(selected.selectedAlternativeIndex, 1);
  assert.equal(selected.selectedReply, draft.alternatives[0]?.text);
});

await run("reply draft rejects alternative indexes outside alternatives range", () => {
  const draft = buildReplyDraftFromTimeline([
    { direction: "in", text: "Necesito subir las imagenes" },
  ], { tone: "neutral", maxLength: 200 });

  assert.throws(
    () => selectReplyFromDraft(draft, 99),
    /alternative_index invalido/i,
  );
});

await run("reply selection rejects stale draft signatures", () => {
  const draft = buildReplyDraftFromTimeline([
    { direction: "in", text: "Necesito subir las imagenes" },
  ], { tone: "neutral", maxLength: 200 });

  assert.throws(
    () => resolveReplySelection(draft, { draftSignature: "deadbeefdeadbeef", alternativeIndex: 1 }),
    /draft_signature ya no coincide/i,
  );
});

await run("reply selection can validate selected_reply against reviewed draft", () => {
  const draft = buildReplyDraftFromTimeline([
    { direction: "in", text: "Necesito subir las imagenes" },
  ], { tone: "neutral", maxLength: 200 });
  const alternativeText = draft.alternatives[0]?.text ?? "";

  const selected = resolveReplySelection(draft, {
    draftSignature: draft.draftSignature,
    selectedReply: alternativeText,
  });

  assert.equal(selected.selectedSource, "alternative");
  assert.equal(selected.selectedReply, alternativeText);
});

await run("reply selection can resolve a reviewed option by optionId", () => {
  const draft = buildReplyDraftFromTimeline([
    { direction: "in", text: "Necesito subir las imagenes" },
  ], { tone: "neutral", maxLength: 200 });

  const optionId = draft.alternatives[0]?.optionId ?? "";
  const selected = resolveReplySelection(draft, {
    draftSignature: draft.draftSignature,
    optionId,
  });

  assert.equal(selected.selectedSource, "alternative");
  assert.equal(selected.selectedOptionId, optionId);
  assert.equal(selected.selectedReply, draft.alternatives[0]?.text);
});

await run("reply draft max alternatives constant matches produced alternatives cap", () => {
  const draft = buildReplyDraftFromTimeline([
    { direction: "in", text: "Necesito subir las imagenes" },
  ], { tone: "neutral", maxLength: 200 });

  assert.equal(draft.alternatives.length <= MAX_REPLY_DRAFT_ALTERNATIVES, true);
  assert.match(draft.recommendedOptionId, /^recommended:/);
});

await run("review token store persists and removes reviewed reply sessions", async () => {
  const repoTmpDir = path.resolve(process.cwd(), "tmp", "reply-reviews");
  mkdirSync(repoTmpDir, { recursive: true });
  const reviewToken = createReviewToken();

  await saveReviewToken({
    reviewToken,
    createdAt: new Date("2026-03-28T16:00:00.000Z").toISOString(),
    expiresAt: new Date("2026-03-28T16:10:00.000Z").toISOString(),
    chatName: "Amor 🤍",
    chatKey: "volatile:title::Amor 🤍",
    chatIndex: 1,
    draftSignature: "abcd1234efgh5678",
    defaultOptionId: "recommended:1234567890ab",
    options: {
      tone: "neutral",
      maxLength: 240,
      messageLimit: 20,
      mediaLimit: 2,
      includeTranscriptions: false,
      includeImageDescriptions: false,
      direction: "any",
    },
  });

  try {
    const stored = await loadReviewToken(reviewToken);
    assert.equal(stored?.reviewToken, reviewToken);
    assert.equal(stored?.defaultOptionId, "recommended:1234567890ab");
    assert.equal(stored?.options.direction, "any");
  } finally {
    await deleteReviewToken(reviewToken);
  }

  const removed = await loadReviewToken(reviewToken);
  assert.equal(removed, null);
});

await run("review token validation accepts only 24-char lowercase hex ids", () => {
  const reviewToken = createReviewToken();
  assert.equal(assertValidReviewToken(reviewToken), reviewToken);
  assert.throws(
    () => assertValidReviewToken("../package"),
    /review_token invalido/i,
  );
  assert.throws(
    () => assertValidReviewToken("ABCDEF1234567890ABCDEF12"),
    /review_token invalido/i,
  );
});

await run("review token file resolver rejects traversal-style tokens", () => {
  assert.throws(
    () => resolveReviewTokenFile("..\\..\\package"),
    /review_token invalido/i,
  );
  assert.throws(
    () => resolveReviewTokenFile("/tmp/escape"),
    /review_token invalido/i,
  );
});

await run("bot config rejects invalid regex patterns instead of ignoring them", () => {
  assert.throws(
    () => buildChatFilterCache([], [], [], ["["]),
    /Regex invalida en excludePatterns/i,
  );
});

await run("chat filter cache applies include and exclude rules without recomputing lists", () => {
  const cache = buildChatFilterCache(
    ["Amor 🤍"],
    ["equipo"],
    ["Spam"],
    ["bloqueado"],
  );

  assert.equal(shouldHandleChatName("Amor 🤍", cache), true);
  assert.equal(shouldHandleChatName("Equipo Producto", cache), true);
  assert.equal(shouldHandleChatName("bloqueado urgente", cache), false);
  assert.equal(shouldHandleChatName("Spam", cache), false);
});

await run("bot loop backoff grows linearly and caps at 30 seconds", () => {
  assert.equal(computeLoopBackoffMs(0), 0);
  assert.equal(computeLoopBackoffMs(1), 1000);
  assert.equal(computeLoopBackoffMs(5), 5000);
  assert.equal(computeLoopBackoffMs(45), 30000);
});

await run("responder module path resolves only files inside responders directory", () => {
  const respondersDir = mkdtempSync(path.join(os.tmpdir(), "wa-mcp-responders-"));
  const nestedDir = path.join(respondersDir, "nested");
  const responderPath = path.join(nestedDir, "demo.mjs");
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(responderPath, "export async function generateReply() { return 'ok'; }\n", "utf8");

  try {
    const resolved = resolveResponderModulePath(respondersDir, "./nested/demo.mjs");
    assert.equal(resolved, responderPath);
  } finally {
    rmSync(respondersDir, { recursive: true, force: true });
  }
});

await run("responder module path rejects traversal outside responders directory", () => {
  const respondersDir = mkdtempSync(path.join(os.tmpdir(), "wa-mcp-responders-"));
  const siblingDir = path.join(path.dirname(respondersDir), `${path.basename(respondersDir)}-outside`);
  mkdirSync(siblingDir, { recursive: true });
  const outsideFile = path.join(siblingDir, "escape.mjs");
  writeFileSync(outsideFile, "export async function generateReply() { return 'no'; }\n", "utf8");

  try {
    assert.throws(
      () => resolveResponderModulePath(respondersDir, `../${path.basename(siblingDir)}/escape.mjs`),
      /debe estar dentro/i,
    );
  } finally {
    rmSync(respondersDir, { recursive: true, force: true });
    rmSync(siblingDir, { recursive: true, force: true });
  }
});

await run("responder module path rejects unsupported extensions", () => {
  const respondersDir = mkdtempSync(path.join(os.tmpdir(), "wa-mcp-responders-"));
  const responderPath = path.join(respondersDir, "demo.txt");
  writeFileSync(responderPath, "not a module\n", "utf8");

  try {
    assert.throws(
      () => resolveResponderModulePath(respondersDir, "./demo.txt"),
      /extension soportada/i,
    );
  } finally {
    rmSync(respondersDir, { recursive: true, force: true });
  }
});

await run("daemon health resolver accepts fresh running process only", () => {
  const now = Date.now();
  const resolved = resolveHealthyProcess({
    updatedAt: new Date(now - 500).toISOString(),
    pid: 123,
    instanceToken: "abc",
  }, now, 2_000, (pid) => pid === 123);

  assert.deepEqual(resolved, { pid: 123, instanceToken: "abc" });
});

await run("daemon health resolver rejects stale heartbeat", () => {
  const now = Date.now();
  const resolved = resolveHealthyProcess({
    updatedAt: new Date(now - 10_000).toISOString(),
    pid: 123,
    instanceToken: "abc",
  }, now, 2_000, () => true);

  assert.equal(resolved, null);
});

await run("tmp clean removes expired review tokens but preserves runtime config files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wa-tmp-clean-"));
  const tmpDir = path.join(root, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(path.join(tmpDir, "reply-reviews"), { recursive: true });

  writeFileSync(path.join(tmpDir, "bot.config.json"), "{}\n", "utf8");
  writeFileSync(path.join(tmpDir, "reply-reviews", "expired.json"), JSON.stringify({
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  }), "utf8");

  const report = cleanTmpDir(tmpDir, "normal");

  assert.equal(report.deletedExpiredReviewTokens, 1);
  assert.equal(report.summary.replyReviewFiles, 0);
  assert.equal(report.summary.preservedEntries.includes("bot.config.json"), true);

  rmSync(root, { recursive: true, force: true });
});

await run("tmp prune removes transient files and managed review directories", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wa-tmp-prune-"));
  const tmpDir = path.join(root, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(path.join(tmpDir, "reply-reviews"), { recursive: true });

  writeFileSync(path.join(tmpDir, "bot.config.json"), "{}\n", "utf8");
  writeFileSync(path.join(tmpDir, "bot-events.log"), "hello\n", "utf8");
  writeFileSync(path.join(tmpDir, "reply-reviews", "active.json"), JSON.stringify({
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), "utf8");

  const report = cleanTmpDir(tmpDir, "prune");
  const summary = getTmpDirSummary(tmpDir);

  assert.equal(report.deletedDirectories >= 1, true);
  assert.equal(summary.files, 1);
  assert.equal(summary.preservedEntries.includes("bot.config.json"), true);
  assert.equal(summary.replyReviewFiles, 0);

  rmSync(root, { recursive: true, force: true });
});
