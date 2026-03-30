import { createHash } from "node:crypto";
import { suggestReplyFromTimeline, type ReplySuggestionMessage, type ReplySuggestionOptions } from "./reply-suggestion.js";

export const MAX_REPLY_DRAFT_ALTERNATIVES = 3;

export interface ReplyDraftOption {
  optionId: string;
  tone: "neutral" | "warm" | "brief" | "supportive";
  text: string;
  reason: string;
}

export interface ReplyDraftBasedOn {
  eventType: "text" | "image" | "voice_note" | "context";
  direction: "in" | "out" | "unknown";
  textExcerpt?: string;
  mediaKind?: "image" | "voice_note";
  usedImageDescription: boolean;
  usedTranscription: boolean;
}

export interface ReplyDraft {
  draftSignature: string;
  recommendedOptionId: string;
  recommendedReply: string;
  alternatives: ReplyDraftOption[];
  reasoningSummary: string;
  basedOn: ReplyDraftBasedOn;
  sendable: boolean;
}

export interface SelectedReplyDraft {
  draftSignature: string;
  selectedReply: string;
  selectedSource: "recommended" | "alternative";
  selectedAlternativeIndex: number | null;
  selectedOptionId: string;
}

export interface ReplyDraftOptions extends ReplySuggestionOptions {
  summary?: string;
  highlights?: string[];
  maxAlternatives?: number;
  seedReply?: string;
}

export interface ReplyDraftSelectionInput {
  alternativeIndex?: number;
  draftSignature?: string;
  selectedReply?: string;
  optionId?: string;
}

const ALL_TONES = ["neutral", "warm", "brief", "supportive"] as const;

function normalizeText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(foto|video|imagen)$/i.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string, maxLength = 120): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(1, maxLength - 1)).trim()}...`;
}

function extractMeaningfulText(message: ReplySuggestionMessage): string {
  const normalized = normalizeText(message.text);
  if (!normalized || normalized === "[Imagen]" || normalized === "[Nota de voz]") return "";
  return normalized;
}

function latestIncomingEvent(messages: ReplySuggestionMessage[]): ReplySuggestionMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.direction !== "in") continue;
    if (extractMeaningfulText(message)) return message;
    if (message.mediaKind === "image" || message.mediaKind === "voice_note") return message;
  }
  return null;
}

function buildBasedOn(message: ReplySuggestionMessage | null): ReplyDraftBasedOn {
  if (!message) {
    return {
      eventType: "context",
      direction: "unknown",
      usedImageDescription: false,
      usedTranscription: false,
    };
  }

  const textExcerpt = extractMeaningfulText(message);
  const usedTranscription = Boolean(
    typeof message.enriched?.voiceNote === "object" &&
    message.enriched?.voiceNote &&
    "transcription" in message.enriched.voiceNote &&
    (message.enriched.voiceNote as { transcription?: { text?: string } }).transcription?.text?.trim(),
  );
  const usedImageDescription = Boolean(
    typeof message.enriched?.imageDescription === "object" &&
    message.enriched?.imageDescription &&
    "description" in message.enriched.imageDescription &&
    String((message.enriched.imageDescription as { description?: string }).description ?? "").trim(),
  );

  return {
    eventType: textExcerpt ? "text" : (message.mediaKind ?? "context"),
    direction: message.direction,
    textExcerpt: textExcerpt ? truncate(textExcerpt, 100) : undefined,
    mediaKind: message.mediaKind,
    usedImageDescription,
    usedTranscription,
  };
}

function buildReasoningSummary(
  messages: ReplySuggestionMessage[],
  latestIncoming: ReplySuggestionMessage | null,
  options: ReplyDraftOptions,
): string {
  const basedOn = buildBasedOn(latestIncoming);
  const parts: string[] = [];
  if (options.summary?.trim()) {
    parts.push(options.summary.trim());
  }

  if (basedOn.eventType === "text" && basedOn.textExcerpt) {
    parts.push(`La recomendacion prioriza el ultimo texto entrante relevante: "${basedOn.textExcerpt}".`);
  } else if (basedOn.eventType === "image") {
    parts.push(
      basedOn.usedImageDescription
        ? "La recomendacion prioriza la ultima imagen entrante y aprovecha su descripcion visual."
        : "La recomendacion prioriza la ultima imagen entrante detectada.",
    );
  } else if (basedOn.eventType === "voice_note") {
    parts.push(
      basedOn.usedTranscription
        ? "La recomendacion prioriza la ultima nota de voz entrante y usa su transcripcion."
        : "La recomendacion prioriza la ultima nota de voz entrante detectada.",
    );
  } else if (messages.length) {
    parts.push("No hubo un evento entrante fuerte; la recomendacion se apoya en el contexto reciente visible.");
  } else {
    parts.push("No hay mensajes recientes visibles suficientes para construir una recomendacion mas especifica.");
  }

  if (options.highlights?.length) {
    parts.push(`Highlights: ${options.highlights.slice(0, 2).join(" | ")}`);
  }

  if (options.seedReply?.trim()) {
    parts.push("La recomendacion conserva una semilla de respuesta proporcionada por la capa operativa.");
  }

  return parts.join(" ");
}

function dedupeAlternatives(items: ReplyDraftOption[], limit: number): ReplyDraftOption[] {
  const seen = new Set<string>();
  const deduped: ReplyDraftOption[] = [];
  for (const item of items) {
    const key = item.text.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

function buildOptionId(prefix: string, tone: string, text: string): string {
  const hash = createHash("sha256").update(`${tone}::${text}`).digest("hex").slice(0, 12);
  return `${prefix}:${hash}`;
}

function buildDraftSignature(payload: {
  recommendedReply: string;
  alternatives: ReplyDraftOption[];
  basedOn: ReplyDraftBasedOn;
  summary?: string;
  highlights?: string[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16);
}

export function buildReplyDraftFromTimeline(
  messages: ReplySuggestionMessage[],
  options: ReplyDraftOptions = {},
): ReplyDraft {
  const tone = options.tone ?? "neutral";
  const maxLength = options.maxLength ?? 240;
  const latestIncoming = latestIncomingEvent(messages);
  const recommendedReply = options.seedReply?.trim()
    ? truncate(options.seedReply.trim(), maxLength)
    : suggestReplyFromTimeline(messages, { tone, maxLength });
  const recommendedOptionId = buildOptionId("recommended", "recommended", recommendedReply);
  const alternatives = dedupeAlternatives(
    ALL_TONES
      .filter((candidateTone) => candidateTone !== tone)
      .map((candidateTone) => ({
        optionId: buildOptionId("alternative", candidateTone, suggestReplyFromTimeline(messages, { tone: candidateTone, maxLength })),
        tone: candidateTone,
        text: suggestReplyFromTimeline(messages, { tone: candidateTone, maxLength }),
        reason:
          candidateTone === "warm" ? "Version mas cercana y afectuosa." :
          candidateTone === "brief" ? "Version corta y rapida de enviar." :
          candidateTone === "supportive" ? "Version mas colaborativa y empatica." :
          "Version neutra y directa.",
      })),
    Math.max(1, options.maxAlternatives ?? MAX_REPLY_DRAFT_ALTERNATIVES),
  );
  const basedOn = buildBasedOn(latestIncoming);
  const reasoningSummary = buildReasoningSummary(messages, latestIncoming, options);
  const draftSignature = buildDraftSignature({
    recommendedReply,
    alternatives,
    basedOn,
    summary: options.summary,
    highlights: options.highlights,
  });

  return {
    draftSignature,
    recommendedOptionId,
    recommendedReply,
    alternatives,
    reasoningSummary,
    basedOn,
    sendable: Boolean(recommendedReply.trim()),
  };
}

export function selectReplyFromDraft(draft: ReplyDraft, alternativeIndex?: number): SelectedReplyDraft {
  if (typeof alternativeIndex !== "number") {
    return {
      draftSignature: draft.draftSignature,
      selectedReply: draft.recommendedReply,
      selectedSource: "recommended",
      selectedAlternativeIndex: null,
      selectedOptionId: draft.recommendedOptionId,
    };
  }

  if (!Number.isInteger(alternativeIndex) || alternativeIndex < 1 || alternativeIndex > draft.alternatives.length) {
    throw new Error(`alternative_index invalido. Debe ser un entero entre 1 y ${draft.alternatives.length}.`);
  }

  const selectedOption = draft.alternatives[alternativeIndex - 1];
  return {
    draftSignature: draft.draftSignature,
    selectedReply: selectedOption?.text ?? draft.recommendedReply,
    selectedSource: "alternative",
    selectedAlternativeIndex: alternativeIndex,
    selectedOptionId: selectedOption?.optionId ?? draft.recommendedOptionId,
  };
}

export function resolveReplySelection(
  draft: ReplyDraft,
  input: ReplyDraftSelectionInput = {},
): SelectedReplyDraft {
  if (input.draftSignature && input.draftSignature !== draft.draftSignature) {
    throw new Error("draft_signature ya no coincide con el contexto actual. Vuelve a generar el borrador antes de enviar.");
  }

  const optionId = input.optionId?.trim();
  if (optionId) {
    if (optionId === draft.recommendedOptionId) {
      return {
        draftSignature: draft.draftSignature,
        selectedReply: draft.recommendedReply,
        selectedSource: "recommended",
        selectedAlternativeIndex: null,
        selectedOptionId: draft.recommendedOptionId,
      };
    }

    const alternativeIndex = draft.alternatives.findIndex((item) => item.optionId === optionId);
    if (alternativeIndex >= 0) {
      return {
        draftSignature: draft.draftSignature,
        selectedReply: draft.alternatives[alternativeIndex]?.text ?? draft.recommendedReply,
        selectedSource: "alternative",
        selectedAlternativeIndex: alternativeIndex + 1,
        selectedOptionId: draft.alternatives[alternativeIndex]?.optionId ?? draft.recommendedOptionId,
      };
    }

    throw new Error("option_id no coincide con ninguna opcion del borrador actual.");
  }

  const selectedReply = input.selectedReply?.trim();
  if (selectedReply) {
    if (selectedReply === draft.recommendedReply) {
      return {
        draftSignature: draft.draftSignature,
        selectedReply,
        selectedSource: "recommended",
        selectedAlternativeIndex: null,
        selectedOptionId: draft.recommendedOptionId,
      };
    }

    const alternativeIndex = draft.alternatives.findIndex((item) => item.text === selectedReply);
    if (alternativeIndex >= 0) {
      return {
        draftSignature: draft.draftSignature,
        selectedReply,
        selectedSource: "alternative",
        selectedAlternativeIndex: alternativeIndex + 1,
        selectedOptionId: draft.alternatives[alternativeIndex]?.optionId ?? draft.recommendedOptionId,
      };
    }

    throw new Error("selected_reply no coincide con ninguna opcion del borrador actual.");
  }

  return selectReplyFromDraft(draft, input.alternativeIndex);
}
