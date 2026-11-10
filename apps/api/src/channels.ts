import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Outbox } from '@salura/agent';

export interface OpenWAConfig {
  baseUrl: string;
  apiKey: string;
  sessionId: string;
  webhookSecret: string;
}

/**
 * Routes outbound messages to the channel the customer used.
 * Web chat needs no delivery: the message is stored and pushed to the browser over SSE.
 */
export class ChannelRouter implements Outbox {
  constructor(private readonly openwa: OpenWAConfig | null) {}

  get whatsappEnabled(): boolean {
    return this.openwa !== null;
  }

  get defaultChannel(): string {
    return this.whatsappEnabled ? 'whatsapp' : 'web';
  }

  async send(input: { waId: string; channel: string; text: string }): Promise<void> {
    if (input.channel !== 'whatsapp') return;
    if (!this.openwa) throw new Error('WhatsApp channel is not configured');
    const res = await fetch(`${this.openwa.baseUrl.replace(/\/$/, '')}/sessions/${this.openwa.sessionId}/messages/send-text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.openwa.apiKey },
      body: JSON.stringify({ chatId: `${input.waId}@c.us`, text: input.text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`OpenWA HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  async sessionStatus(): Promise<{ configured: boolean; status: string }> {
    if (!this.openwa) return { configured: false, status: 'not_configured' };
    try {
      const res = await fetch(`${this.openwa.baseUrl.replace(/\/$/, '')}/sessions/${this.openwa.sessionId}`, {
        headers: { 'x-api-key': this.openwa.apiKey },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return { configured: true, status: `error_${res.status}` };
      const json = (await res.json()) as any;
      return { configured: true, status: String(json?.status ?? json?.data?.status ?? 'unknown') };
    } catch {
      return { configured: true, status: 'unreachable' };
    }
  }

  /** OpenWA signs deliveries with an HMAC-SHA256 of the raw body (header name to confirm against the running instance). */
  verifySignature(rawBody: string, header: string | undefined): boolean {
    // No secret configured means no way to tell real deliveries from forged ones: refuse all.
    if (!this.openwa?.webhookSecret) return false;
    if (!header) return false;
    const expected = createHmac('sha256', this.openwa.webhookSecret).update(rawBody).digest('hex');
    const given = header.replace(/^sha256=/, '');
    return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }
}

export interface ParsedInbound {
  /** WhatsApp message id, used to ignore redelivered webhooks. */
  id?: string;
  waId: string;
  kind: 'text' | 'voice' | 'image';
  text?: string;
  media?: { base64: string; mimetype: string };
}

/**
 * Normalizes an OpenWA `message.received` webhook. The payload schema is not documented in the
 * README, so this accepts the common whatsapp-web.js shapes and ignores anything it cannot read.
 * TODO: confirm field names against the running instance's Swagger (/api/docs) before the demo.
 */
export function parseOpenWAWebhook(body: any): ParsedInbound | null {
  const event = body?.event ?? body?.type;
  if (event && event !== 'message.received' && event !== 'message') return null;
  const msg = body?.data?.message ?? body?.data ?? body?.payload ?? body?.message ?? body;
  if (!msg || msg.fromMe || msg.isGroup) return null;
  const from: string | undefined = msg.from ?? msg.chatId ?? msg.sender;
  if (!from || from.endsWith('@g.us')) return null;
  const waId = from.replace(/@.*$/, '');
  if (!/^\d{8,15}$/.test(waId)) return null;
  const rawId = msg.id?._serialized ?? msg.id?.id ?? msg.id;
  const id = typeof rawId === 'string' && rawId ? rawId : undefined;
  const type: string = String(msg.type ?? (msg.hasMedia ? 'media' : 'chat'));
  const media = msg.media?.data ? { base64: String(msg.media.data), mimetype: String(msg.media.mimetype ?? 'application/octet-stream') } : undefined;
  if (type === 'ptt' || type === 'audio') return { id, waId, kind: 'voice', media };
  if (type === 'image') return { id, waId, kind: 'image', text: msg.caption ?? msg.body, media };
  const text = String(msg.body ?? msg.text ?? '').trim();
  return text ? { id, waId, kind: 'text', text } : null;
}
