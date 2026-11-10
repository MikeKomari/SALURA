import { splitThinking } from './llm/openai-compatible.ts';
import type { MediaFile } from './media.ts';

/**
 * What the photo is expected to show; each kind has its own transcription rules.
 * `chat_photo`: anything a customer sends; the reader first says which kind it is (see parsePhotoText).
 */
export type DocumentKind = 'order_list' | 'delivery_document' | 'chat_photo';

export const PHOTO_TYPES = ['order_list', 'payment_proof', 'delivery_document', 'other'] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

export interface VisionReader {
  readonly name: string;
  /** Text of the document in the photo, one item per line. Empty when the photo has no such document. */
  read(file: MediaFile, kind?: DocumentKind): Promise<{ text: string }>;
}

const NO_ORDER = 'NO_ORDER';

const READ_INSTRUCTIONS = `You transcribe photos that warung owners send to an Indonesian FMCG distributor. The photo is usually a handwritten or printed list of products to order.
Write every order line exactly as written: product, quantity and unit, one item per line, in the original language and spelling.
- Do not translate, correct spelling, merge lines or add products.
- Leave out prices, totals, dates and anything that is not an item to order.
- Write [?] in place of any word or number you cannot read.
- If the photo contains no order list, reply exactly ${NO_ORDER}.
Reply with the lines only, no commentary.`;

const CHAT_PHOTO_INSTRUCTIONS = `You read photos that warung owners send on WhatsApp to an Indonesian FMCG distributor.
First line, exactly one of:
TYPE: order_list         (a handwritten or printed list of products they want to order)
TYPE: payment_proof      (a bank transfer receipt, m-banking or e-wallet screenshot, QRIS payment)
TYPE: delivery_document  (a surat jalan, nota or faktur from the distributor)
TYPE: other              (anything else)
Then, depending on the type:
- order_list: every order line exactly as written: product, quantity and unit, one item per line, in the original language and spelling. Leave out prices, totals and dates. Do not translate, correct spelling, merge lines or add products.
- payment_proof: only the fields you can see, one per line: "Jumlah: <amount as shown>", "Tanggal: <date as shown>", "Bank: <bank or app>", "Referensi: <reference number>", "Pengirim: <sender name>", "Penerima: <recipient name>", "Berita: <transfer note>".
- delivery_document: the document number and date if visible, then one line per item exactly as written (quantity, unit, prices if shown), keeping handwritten corrections like "5 → 4", and a final "Catatan:" line for notes such as "kurang 1".
- other: one short line describing the photo.
Write [?] in place of any word or number you cannot read. Reply with the lines only, no commentary.`;

const DELIVERY_INSTRUCTIONS = `You transcribe photos of Indonesian delivery documents: a surat jalan (delivery note) or a nota/faktur (invoice) from an FMCG distributor to a warung.
First line: the document number and date if visible, e.g. "No: SJ-0123 · 16/10/2026". Then one line per item, exactly as written: product, quantity, unit, and the unit price and line total if shown.
- Keep handwritten corrections visible, e.g. "Kapal Api 5 → 4 renceng" when 5 is crossed out and 4 written. Mark crossed-out items with [coret] and ticked items with [✓].
- Copy signatures, stamps and notes such as "kurang 1" or "rusak 2" as a final line starting with "Catatan:".
- Do not translate, correct spelling, merge lines or add items. Write [?] for anything you cannot read.
- If the photo is not a delivery note or invoice, reply exactly ${NO_ORDER}.
Reply with the lines only, no commentary.`;

/** Any OpenAI-compatible /chat/completions endpoint with a vision model (image sent as a data URI). */
export class OpenAICompatibleVision implements VisionReader {
  readonly name: string;

  constructor(private readonly config: { baseUrl: string; apiKey: string; model: string; timeoutMs?: number }) {
    this.name = config.model;
  }

  async read(file: MediaFile, kind: DocumentKind = 'order_list'): Promise<{ text: string }> {
    const mime = file.mime.startsWith('image/') ? file.mime : 'image/jpeg';
    const dataUri = `data:${mime};base64,${file.data.toString('base64')}`;
    const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0,
        max_tokens: 800,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: kind === 'delivery_document' ? DELIVERY_INSTRUCTIONS : kind === 'chat_photo' ? CHAT_PHOTO_INSTRUCTIONS : READ_INSTRUCTIONS },
              { type: 'image_url', image_url: { url: dataUri } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 45_000),
    });
    if (!res.ok) throw new Error(`Vision HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const { text } = splitThinking(String(json.choices?.[0]?.message?.content ?? ''));
    return { text: text === NO_ORDER ? '' : text };
  }
}

/**
 * Reads the text stored with the photo.
 * Used by the evaluation dataset and as a fallback when no vision provider is configured.
 */
export class SidecarVision implements VisionReader {
  readonly name = 'sidecar-text';

  async read(file: MediaFile): Promise<{ text: string }> {
    if (file.sidecarText === null) throw new Error('Photo reading is not configured and no stored text exists for this photo');
    return { text: file.sidecarText.trim() };
  }
}

/** Tries the primary provider, then the stored text. */
export class FallbackVision implements VisionReader {
  readonly name: string;

  constructor(private readonly providers: VisionReader[]) {
    this.name = providers.map((p) => p.name).join(' → ');
  }

  async read(file: MediaFile, kind?: DocumentKind): Promise<{ text: string }> {
    let lastError: unknown;
    for (const p of this.providers) {
      try {
        return await p.read(file, kind);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/**
 * Splits a chat-photo reading into its type and lines. Text without a "TYPE:" header (older
 * transcripts, the eval dataset) is an order list; the NO_ORDER sentinel means nothing was read.
 */
export function parsePhotoText(text: string): { type: PhotoType; lines: string[] } {
  const raw = text.split('\n').map((l) => l.replace(/^\s*[-*•]\s+/, '').trim()).filter(Boolean);
  if (raw.length === 1 && raw[0] === NO_ORDER) return { type: 'other', lines: [] };
  const header = /^TYPE:\s*(\w+)/i.exec(raw[0] ?? '');
  if (!header) return { type: 'order_list', lines: raw };
  const type = (PHOTO_TYPES as readonly string[]).includes(header[1]!.toLowerCase()) ? (header[1]!.toLowerCase() as PhotoType) : 'other';
  return { type, lines: raw.slice(1) };
}
