export async function generateReply(context) {
  const lastInbound = [...context.messages].reverse().find((message) => message.direction === "in");
  if (!lastInbound) return null;

  if (context.latestVoiceNote?.transcription?.text) {
    return [
      "Estoy operando en modo demo.",
      `Chat: ${context.chatName}`,
      `Transcripcion de la nota de voz: ${context.latestVoiceNote.transcription.text}`
    ].join("\n");
  }

  return [
    "Estoy operando en modo demo.",
    `Chat: ${context.chatName}`,
    `Ultimo mensaje: ${lastInbound.text}`
  ].join("\n");
}
