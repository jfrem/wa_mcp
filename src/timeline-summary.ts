export interface TimelineSummaryMessage {
  direction: "in" | "out" | "unknown";
  text: string;
  mediaKind?: "image" | "voice_note";
}

export interface TimelineSummaryResult {
  summary: string;
  highlights: string[];
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isEmojiOnly(value: string): boolean {
  return /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\u200D\uFE0F\s]+$/u.test(value);
}

function normalizeSummaryText(value: string): string {
  const cleanedLines = value
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean)
    .filter((line) => !/^(foto|video|imagen)$/i.test(line))
    .filter((line) => !isEmojiOnly(line));

  return cleanText(cleanedLines.join(" "));
}

function truncate(value: string, maxLength = 120): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trim()}...`;
}

function isMeaningfulText(value: string): boolean {
  const normalized = normalizeSummaryText(value);
  return Boolean(normalized) && normalized !== "[Imagen]" && normalized !== "[Nota de voz]";
}

export function summarizeTimelineMessages(messages: TimelineSummaryMessage[]): TimelineSummaryResult {
  const incomingTexts = messages.filter((message) => message.direction === "in" && isMeaningfulText(message.text));
  const outgoingTexts = messages.filter((message) => message.direction === "out" && isMeaningfulText(message.text));
  const imageCount = messages.filter((message) => message.mediaKind === "image").length;
  const voiceNoteCount = messages.filter((message) => message.mediaKind === "voice_note").length;

  const latestIncoming = incomingTexts.at(-1);
  const latestOutgoing = outgoingTexts.at(-1);
  const highlights: string[] = [];

  if (latestIncoming) {
    highlights.push(`Ultimo mensaje recibido: ${truncate(normalizeSummaryText(latestIncoming.text))}`);
  }
  if (latestOutgoing) {
    highlights.push(`Ultimo mensaje enviado: ${truncate(normalizeSummaryText(latestOutgoing.text))}`);
  }
  if (imageCount > 0) {
    highlights.push(`Imagenes recientes detectadas: ${imageCount}.`);
  }
  if (voiceNoteCount > 0) {
    highlights.push(`Notas de voz recientes detectadas: ${voiceNoteCount}.`);
  }

  const summaryParts: string[] = [];
  if (incomingTexts.length) {
    summaryParts.push(`Hay ${incomingTexts.length} mensajes entrantes con texto en el tramo reciente.`);
  }
  if (outgoingTexts.length) {
    summaryParts.push(`Hay ${outgoingTexts.length} mensajes salientes con texto en el tramo reciente.`);
  }
  if (imageCount || voiceNoteCount) {
    summaryParts.push(`El chat incluye ${imageCount} imagen(es) real(es) y ${voiceNoteCount} nota(s) de voz en la ventana analizada.`);
  }
  if (latestIncoming) {
    summaryParts.push(`El ultimo contenido entrante relevante dice: "${truncate(normalizeSummaryText(latestIncoming.text), 100)}"`);
  }

  return {
    summary: summaryParts.join(" "),
    highlights,
  };
}
