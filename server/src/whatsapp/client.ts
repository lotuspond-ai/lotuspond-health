// The WhatsApp Cloud API (Meta Graph API): send text replies, show that a message was read and a reply is being
// written, and download media people send. Everything is sent from the business phone number in WHATSAPP_*.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.ts';

export type WhatsAppConfig = NonNullable<Config['whatsapp']>;

/** WhatsApp caps a text message at 4096 characters. */
const MAX_TEXT = 4096;

export interface WhatsAppClient {
  sendText(to: string, body: string): Promise<void>;
  /** Mark a received message read and show "typing…" until the reply (best effort). */
  markRead(messageId: string, typing?: boolean): Promise<void>;
  /** Download media by its id, refusing files over maxBytes. */
  download(mediaId: string, maxBytes: number): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

export class WhatsAppError extends Error {
  constructor(readonly code: 'too_large' | 'failed', message: string) {
    super(message);
  }
}

/** Check the X-Hub-Signature-256 header Meta signs each delivery with (HMAC-SHA256 of the raw body, app secret). */
export function validSignature(appSecret: string, rawBody: string | Uint8Array, header: string | undefined): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header?.trim() ?? '');
  if (!m) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(m[1], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Split a long reply at paragraph or line breaks so each part fits in one message. */
export function splitText(text: string, max = MAX_TEXT): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('. ') + 1);
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function cloudApiClient(cfg: WhatsAppConfig, fetchImpl: typeof fetch = fetch): WhatsAppClient {
  const auth = { Authorization: `Bearer ${cfg.accessToken}` };
  const post = async (body: unknown) => {
    const res = await fetchImpl(`${cfg.graphUrl}/${cfg.phoneNumberId}/messages`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      // The error body names the problem (an expired token, a closed 24-hour window); it never holds message text.
      const detail = await res.text().catch(() => '');
      throw new WhatsAppError('failed', `WhatsApp API ${res.status}: ${detail.slice(0, 300)}`);
    }
  };
  return {
    async sendText(to, body) {
      for (const part of splitText(body)) {
        await post({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: part, preview_url: false } });
      }
    },
    async markRead(messageId, typing = false) {
      try {
        await post({ messaging_product: 'whatsapp', status: 'read', message_id: messageId, ...(typing ? { typing_indicator: { type: 'text' } } : {}) });
      } catch { /* only a courtesy */ }
    },
    async download(mediaId, maxBytes) {
      const meta = await fetchImpl(`${cfg.graphUrl}/${encodeURIComponent(mediaId)}`, { headers: auth, signal: AbortSignal.timeout(20_000) });
      if (!meta.ok) throw new WhatsAppError('failed', `WhatsApp media lookup ${meta.status}`);
      const info = await meta.json() as { url?: string; mime_type?: string; file_size?: number };
      if (!info.url) throw new WhatsAppError('failed', 'WhatsApp media has no URL');
      if ((info.file_size ?? 0) > maxBytes) throw new WhatsAppError('too_large', 'The file is too large.');
      const res = await fetchImpl(info.url, { headers: auth, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new WhatsAppError('failed', `WhatsApp media download ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new WhatsAppError('too_large', 'The file is too large.');
      return { bytes, mimeType: (info.mime_type ?? res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase() };
    },
  };
}
