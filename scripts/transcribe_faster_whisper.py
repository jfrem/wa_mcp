import json
import os
import sys
from typing import Any


def fail(message: str, exit_code: int = 1) -> None:
    sys.stderr.write(message.strip() + "\n")
    raise SystemExit(exit_code)


def load_payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        fail("No se recibio payload JSON en stdin")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"Payload JSON invalido: {exc}")
    if not isinstance(payload, dict):
        fail("El payload debe ser un objeto JSON")
    return payload


def main() -> None:
    payload = load_payload()

    audio_path = str(payload.get("audioPath") or "").strip()
    if not audio_path:
        fail("audioPath es obligatorio")
    if not os.path.isfile(audio_path):
        fail(f"No existe el archivo de audio: {audio_path}")

    model_name = str(payload.get("model") or "small").strip() or "small"
    language = str(payload.get("language") or "").strip() or None
    beam_size = int(payload.get("beamSize") or 5)
    device = str(payload.get("device") or "cpu").strip() or "cpu"
    compute_type = str(payload.get("computeType") or "int8").strip() or "int8"

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        fail(
            "No se pudo importar faster_whisper. Instala dependencias con "
            "'pip install faster-whisper'. Detalle: "
            f"{exc}"
        )

    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
        segments, info = model.transcribe(
            audio_path,
            language=language,
            beam_size=beam_size,
            vad_filter=True,
        )
    except Exception as exc:
        fail(f"Fallo la transcripcion con faster-whisper: {exc}")

    result_segments: list[dict[str, Any]] = []
    text_parts: list[str] = []
    duration_seconds = 0.0

    for index, segment in enumerate(segments):
        text = (getattr(segment, "text", "") or "").strip()
        start = float(getattr(segment, "start", 0.0) or 0.0)
        end = float(getattr(segment, "end", 0.0) or 0.0)
        duration_seconds = max(duration_seconds, end)
        if text:
            text_parts.append(text)
        result_segments.append(
            {
                "id": index,
                "start": start,
                "end": end,
                "text": text,
                "avgLogProb": getattr(segment, "avg_logprob", None),
                "noSpeechProb": getattr(segment, "no_speech_prob", None),
            }
        )

    response = {
      "ok": True,
      "text": " ".join(part for part in text_parts if part).strip(),
      "language": getattr(info, "language", None) or language or "",
      "durationSeconds": duration_seconds,
      "model": model_name,
      "segments": result_segments,
    }

    sys.stdout.write(json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    main()
