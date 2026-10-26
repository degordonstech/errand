import { fetchRetry } from "../net.js";
import { config } from "../config.js";
import { toTranscriptionWav } from "../media/ffmpeg.js";

const LANGUAGES = ["English", "Nigerian Pidgin"];

/**
 * Voice note to text with Muse Voice Transcribe.
 * `keywords` should carry names the user is likely to say (contacts, business name);
 * it noticeably improves spelling of Nigerian names.
 */
export async function transcribe(audio: Buffer, keywords: string[] = []): Promise<string> {
  const wav = await toTranscriptionWav(audio);

  const settings = {
    model: config.MUSE_TRANSCRIBE_MODEL,
    audioEncoding: "WAV",
    mode: "PUSH_TO_TALK",
    languageBias: LANGUAGES,
    ...(keywords.length ? { keywords: keywords.slice(0, 50) } : {}),
  };
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify(settings)], { type: "application/json" }));
  form.append("audio", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voice.wav");

  const res = await fetchRetry(`${config.META_API_BASE_URL}/asr/transcribe`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.META_API_KEY}`, Accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`transcribe failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { transcript?: string };
  return (body.transcript ?? "").trim();
}
