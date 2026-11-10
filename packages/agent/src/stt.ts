import type { MediaFile } from './media.ts';

export interface SpeechToText {
  readonly name: string;
  transcribe(file: MediaFile): Promise<{ text: string }>;
}

/** Any OpenAI-compatible /audio/transcriptions endpoint (Groq, OpenAI Whisper, a local faster-whisper server). */
export class OpenAICompatibleStt implements SpeechToText {
  readonly name: string;

  constructor(private readonly config: { baseUrl: string; apiKey: string; model: string; timeoutMs?: number }) {
    this.name = config.model;
  }

  async transcribe(file: MediaFile): Promise<{ text: string }> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.data)], { type: file.mime }), file.id);
    form.append('model', this.config.model);
    form.append('language', 'id');
    form.append('response_format', 'json');
    const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`STT HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { text?: string };
    return { text: String(json.text ?? '').trim() };
  }
}

/** Container formats a multimodal chat model accepts as `input_audio` (verified: wav and mp3 only). */
const CHAT_AUDIO_FORMATS: Record<string, 'wav' | 'mp3'> = {
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
};

const TRANSCRIBE_PROMPT =
  'Transcribe this Indonesian voice note word for word. It is a shop owner ordering groceries from a distributor, so expect product names, brands, numbers and units (dus, renceng, karung, pcs). ' +
  'Reply with the transcript only: no translation, no summary, no quotation marks and no commentary. If the audio contains no speech, reply with exactly [NO_SPEECH].';

/**
 * Speech to text through a multimodal chat model that takes audio as an `input_audio` content part
 * (for example `openai/gpt-audio` on Nous Portal), for providers that serve no /audio/transcriptions
 * endpoint. The audio must already be wav or mp3: these models reject ogg, webm and m4a, so a
 * WhatsApp voice note has to be converted before it gets here.
 */
export class ChatAudioStt implements SpeechToText {
  readonly name: string;

  constructor(private readonly config: { baseUrl: string; apiKey: string; model: string; timeoutMs?: number; prompt?: string }) {
    this.name = config.model;
  }

  async transcribe(file: MediaFile): Promise<{ text: string }> {
    const mime = file.mime.split(';')[0]!.trim().toLowerCase();
    const format = CHAT_AUDIO_FORMATS[mime];
    if (!format) {
      throw new Error(`${this.config.model} accepts only wav and mp3 audio, not ${mime || 'an unknown type'}`);
    }
    const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: this.config.prompt ?? TRANSCRIBE_PROMPT },
              { type: 'input_audio', input_audio: { data: file.data.toString('base64'), format } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
    });
    if (!res.ok) throw new Error(`STT HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const raw = json.choices?.[0]?.message?.content;
    // Models sometimes wrap the transcript in quotes despite the instruction; the agent wants the words only.
    const text = String(typeof raw === 'string' ? raw : '')
      .trim()
      .replace(/^["\u201c\u2018]|["\u201d\u2019]$/g, '')
      .trim();
    // Nothing usable must fail, so the next provider or the escalation takes over instead of the
    // agent reading "[NO_SPEECH]" as an order.
    if (!text || /^\[?NO_SPEECH\]?$/i.test(text)) throw new Error('No speech could be transcribed from this voice note');
    return { text };
  }
}

/**
 * Reads the transcript stored with the voice note.
 * Used by the evaluation dataset and as a fallback when no STT provider is configured.
 */
export class SidecarStt implements SpeechToText {
  readonly name = 'sidecar-transcript';

  async transcribe(file: MediaFile): Promise<{ text: string }> {
    if (file.sidecarText === null) throw new Error('Speech-to-text is not configured and no stored transcript exists for this voice note');
    return { text: file.sidecarText.trim() };
  }
}

/** Tries the primary provider, then the stored transcript. */
export class FallbackStt implements SpeechToText {
  readonly name: string;

  constructor(private readonly providers: SpeechToText[]) {
    this.name = providers.map((p) => p.name).join(' → ');
  }

  async transcribe(file: MediaFile): Promise<{ text: string }> {
    let lastError: unknown;
    for (const p of this.providers) {
      try {
        return await p.transcribe(file);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
