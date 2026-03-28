export const SEARCH_INPUT_SELECTORS = [
  "input[aria-label='Buscar un chat o iniciar uno nuevo']",
  "input[placeholder='Buscar un chat o iniciar uno nuevo']",
  "input[aria-label='Search or start new chat']",
  "input[placeholder='Search or start new chat']",
  "input[role='textbox'][type='text']",
  "header input[type='text']",
];

export const SEARCH_RESULTS_ARIA_LABELS = [
  "Resultados de la búsqueda.",
  "Search results.",
];

export const VOICE_NOTE_CONTROL_LABEL_PATTERNS = [
  /reproducir mensaje de voz/i,
  /pausar mensaje de voz/i,
  /play voice message/i,
  /pause voice message/i,
];

export function buildSearchInputSelector(): string {
  return SEARCH_INPUT_SELECTORS.join(", ");
}

export function matchesSearchResultsLabel(label: string): boolean {
  const normalized = label.trim();
  return SEARCH_RESULTS_ARIA_LABELS.some((candidate) => candidate === normalized);
}

export function matchesVoiceNoteControlLabel(label: string): boolean {
  const normalized = label.trim();
  return VOICE_NOTE_CONTROL_LABEL_PATTERNS.some((pattern) => pattern.test(normalized));
}
