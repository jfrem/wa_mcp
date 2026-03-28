export interface ReplySuggestionMessage {
  direction: "in" | "out" | "unknown";
  text: string;
  mediaKind?: "image" | "voice_note";
  enriched?: Record<string, unknown>;
}

export interface ReplySuggestionOptions {
  tone?: "neutral" | "warm" | "brief" | "supportive";
  maxLength?: number;
}

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

function truncate(value: string, maxLength: number): string {
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

export function suggestReplyFromTimeline(
  messages: ReplySuggestionMessage[],
  options: ReplySuggestionOptions = {},
): string {
  const tone = options.tone ?? "neutral";
  const maxLength = options.maxLength ?? 240;
  const latestIncoming = latestIncomingEvent(messages);
  const latestIncomingText = latestIncoming ? extractMeaningfulText(latestIncoming) : "";

  let suggestion = "";
  if (latestIncomingText) {
    if (tone === "brief") {
      suggestion = `Sí, ya vi esto: ${latestIncomingText}.`;
    } else if (tone === "warm") {
      suggestion = `Sí amor, ya vi esto: ${latestIncomingText}. Ahorita te respondo bien.`;
    } else if (tone === "supportive") {
      suggestion = `Ya vi lo que me dijiste: ${latestIncomingText}. Estoy pendiente y te ayudo con eso.`;
    } else {
      suggestion = `Ya vi lo que me dijiste: ${latestIncomingText}.`;
    }
    return truncate(suggestion, maxLength);
  }

  const media = latestIncoming;
  if (media?.mediaKind === "voice_note") {
    const transcription = typeof media.enriched?.voiceNote === "object" && media.enriched?.voiceNote && "transcription" in media.enriched.voiceNote
      ? (media.enriched.voiceNote as { transcription?: { text?: string } }).transcription?.text?.trim()
      : "";
    if (transcription) {
      suggestion = tone === "brief"
        ? `Sí, ya escuché la nota: ${transcription}.`
        : `Sí, ya escuché la nota. Entendí esto: ${transcription}.`;
    } else {
      suggestion = tone === "warm"
        ? "Sí, ya vi tu nota de voz. Déjame la escucho bien y te respondo."
        : "Ya vi tu nota de voz. Déjame la reviso y te respondo.";
    }
    return truncate(suggestion, maxLength);
  }

  if (media?.mediaKind === "image") {
    const imageDescription = typeof media.enriched?.imageDescription === "object" && media.enriched?.imageDescription && "description" in media.enriched.imageDescription
      ? String((media.enriched.imageDescription as { description?: string }).description ?? "").trim()
      : "";
    if (imageDescription) {
      suggestion = tone === "brief"
        ? `Sí, ya vi la imagen: ${imageDescription}.`
        : `Sí, ya vi la imagen. Entiendo esto: ${imageDescription}.`;
    } else {
      suggestion = tone === "supportive"
        ? "Ya vi la imagen que me mandaste. Estoy pendiente de eso."
        : "Ya vi la imagen que me mandaste.";
    }
    return truncate(suggestion, maxLength);
  }

  if (tone === "warm") return "Sí amor, ya vi esto. Enseguida te respondo bien.";
  if (tone === "supportive") return "Ya vi el contexto reciente y estoy pendiente para responderte bien.";
  if (tone === "brief") return "Ya vi esto. Te respondo enseguida.";
  return "Ya vi el contexto reciente. Te respondo enseguida.";
}
