// Email (Gmail, Outlook) as a record agent source: report PDFs that labs, hospitals and pharmacies email people.
//
// The person signs in on Google's or Microsoft's page with read-only mail access. Each check:
//   1. Lists emails received since the last check (a year back the first time) that have attachments.
//   2. Keeps only health emails: from a known lab, hospital or pharmacy domain, or with a subject that names a lab
//      report, test result, prescription or discharge summary. Email bodies are never read or kept.
//   3. Downloads their PDF attachments (not bills, invoices, receipts or brochures), each saved once.
// Many Indian labs send password-protected PDFs (the password is often derived from the name and date of birth): they
// are saved like any other, and the run notes how many there were.
//
//   Gmail    sign-in accounts.google.com/o/oauth2/v2/auth (access_type=offline, prompt=consent), token
//            oauth2.googleapis.com/token, scope gmail.readonly (a restricted scope: Google's verification and a security
//            assessment before more than 100 test users). GET gmail/v1/users/me/messages?q=…, messages/{id}?format=full,
//            messages/{id}/attachments/{attachmentId}.
//   Outlook  sign-in login.microsoftonline.com/common/oauth2/v2.0/authorize, scopes offline_access Mail.Read (personal
//            and work accounts). GET graph.microsoft.com/v1.0/me/messages?$filter=receivedDateTime ge … and
//            hasAttachments eq true, then /me/messages/{id}/attachments (contentBytes).
//
// Written from Google's and Microsoft's API references and tested against copies of them (test/mail.test.ts); not yet
// run against real mailboxes.
import { PortalError, type PortalReport } from '../recipes/types.ts';
import { oauthSession, type OAuthClient, type Tokens } from './oauth2.ts';
import type { ApiContext, OAuthFetcher } from './types.ts';

/** Senders whose PDFs are health records: Indian labs, hospital groups, pharmacies and health apps. */
export const HEALTH_SENDER_DOMAINS = [
  'lalpathlabs.com', 'thyrocare.com', 'metropolisindia.com', 'agilus.in', 'agilusdiagnostics.com', 'srl.in', 'redcliffelabs.com',
  'healthians.com', 'orangehealth.in', 'neubergdiagnostics.com', 'vijayadiagnostic.com', 'pathkindlabs.com', 'tatamd.com',
  'apollo247.com', 'apollohospitals.com', 'apollodiagnostics.in', 'apollopharmacy.in', 'fortishealthcare.com', 'maxhealthcare.com',
  'manipalhospitals.com', 'narayanahealth.org', 'medanta.org', 'aiims.edu', 'kimshospitals.com', 'yashodahospitals.com',
  'carehospitals.com', 'asterhospitals.in', 'rainbowhospitals.in', 'ckbirlahospitals.com', '1mg.com', 'pharmeasy.in',
  'netmeds.com', 'practo.com', 'eka.care', 'mfine.co', 'healthifyme.com',
];

/** A subject that names a medical document (on its own, without a known sender). */
const HEALTH_SUBJECT = /\b(?:lab(?:oratory)?|test|diagnostic|pathology|blood|investigation|health\s*check(?:\s*-?\s*up)?|medical|clinical|radiology|scan|x-?ray|mri|ct|ultrasound|ecg|echo)\s+(?:report|result)s?\b|\bdischarge\s+summary\b|\bprescription\b|\breport(?:s)?\s+(?:is|are)\s+ready\b/i;
/** Attachments that are not records. */
const NOT_A_RECORD = /invoice|receipt|\bbill\b|tax|brochure|offer|newsletter|terms|catalog(?:ue)?|price\s*list/i;

const FIRST_DAYS = 365;
/** Emails looked at per check, at most. */
const MAX_MESSAGES = 200;

export function senderDomain(from: string): string {
  const m = /<?([^<>\s@]+@([^<>\s]+?))>?\s*$/.exec(from.trim());
  return (m?.[2] ?? '').toLowerCase();
}

/** Whether an email is a health email: a known sender, or a subject naming a medical document. */
export function isHealthEmail(from: string, subject: string): boolean {
  const d = senderDomain(from);
  if (d && HEALTH_SENDER_DOMAINS.some(h => d === h || d.endsWith(`.${h}`))) return true;
  return HEALTH_SUBJECT.test(subject);
}

/** Whether an attachment is a PDF worth saving. */
export function isRecordPdf(name: string, contentType: string, size: number, maxBytes: number): boolean {
  const pdf = /\.pdf$/i.test(name) || /application\/pdf/i.test(contentType);
  return pdf && !NOT_A_RECORD.test(name) && size > 0 && size <= maxBytes;
}

const isEncryptedPdf = (bytes: Uint8Array) => Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 1_000_000))).includes('/Encrypt');

interface Found { key: string; subject: string; received: number; name: string; bytes: Uint8Array }

function toReports(found: Found[]): PortalReport[] {
  return found.map(f => ({
    key: f.key, title: (f.subject || f.name).slice(0, 160), date: new Date(f.received).toISOString().slice(0, 10),
    fileName: f.name.replace(/\.pdf$/i, '') || 'Report', contentType: 'application/pdf', bytes: f.bytes,
  }));
}

type MailTokens = Tokens & { since?: number };

/** What every mail check shares: the window, the notes, the cursor. */
async function check(ctx: ApiContext, device: string, s: { tokens: MailTokens; progress(extra: Partial<MailTokens>): void }, now: number, list: (since: number) => Promise<Found[]>): Promise<PortalReport[]> {
  await ctx.step(`Looking for reports in your ${device} email`);
  // A day of overlap with the last check: an email that arrived while it ran is not missed (each is saved once).
  const since = s.tokens.since ? s.tokens.since - 86_400_000 : now - FIRST_DAYS * 86_400_000;
  const found = await list(since);
  const locked = found.filter(f => isEncryptedPdf(f.bytes)).length;
  if (locked) ctx.note(`${locked} of the reports are password-protected PDFs. Labs often use your name and date of birth as the password; open them in Files to read them.`);
  // The cursor moves only once these reports are saved (a failed save reads the same mail again).
  s.progress({ since: now });
  return toReports(found);
}

/* ---------------- Gmail ---------------- */

export const GMAIL_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GMAIL_API_URL = 'https://gmail.googleapis.com';

interface GmailPart { partId?: string; filename?: string; mimeType?: string; body?: { attachmentId?: string; size?: number; data?: string }; parts?: GmailPart[] }

/** The Gmail search for health emails with PDFs since a time (the local rule is applied again on each email). */
export function gmailQuery(sinceMs: number): string {
  const from = HEALTH_SENDER_DOMAINS.map(d => `from:${d}`).join(' OR ');
  const subject = 'subject:("lab report" OR "test report" OR "test results" OR "diagnostic report" OR "health checkup" OR "discharge summary" OR prescription OR "report is ready" OR "reports are ready")';
  return `has:attachment filename:pdf after:${Math.floor(sinceMs / 1000)} {${from} ${subject}}`;
}

export function gmailFetcher(client: OAuthClient, opts: { apiUrl?: string; authorizeUrl?: string; tokenUrl?: string; fetch?: typeof fetch; now?: () => number } = {}): OAuthFetcher {
  const api = (opts.apiUrl ?? GMAIL_API_URL).replace(/\/+$/, '');
  const now = opts.now ?? Date.now;
  const session = oauthSession<MailTokens>({
    sourceId: 'gmail', device: 'Gmail',
    authorizeUrl: opts.authorizeUrl ?? GMAIL_AUTHORIZE_URL, tokenUrl: opts.tokenUrl ?? GMAIL_TOKEN_URL,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    // Without these Google sends no refresh token, and the connection would last an hour.
    authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    forbidden: 'Gmail did not share your email: allow LotusPond to read your email on Google’s page, then connect again.',
  }, client, opts);
  return {
    sourceId: 'gmail',
    authorizeUrl: state => session.authorizeUrl(state),
    exchange: code => session.exchange(code),
    async run(ctx) {
      const s = await session.signIn(ctx);
      const base = `${api}/gmail/v1/users/me`;
      return check(ctx, 'Gmail', s, now(), async since => {
        const ids: string[] = [];
        let page: string | undefined;
        do {
          const q = new URLSearchParams({ q: gmailQuery(since), maxResults: '100', ...(page ? { pageToken: page } : {}) });
          const b = await s.get(`${base}/messages?${q}`) as { messages?: { id: string }[]; nextPageToken?: string };
          ids.push(...(b.messages ?? []).map(m => m.id));
          page = b.nextPageToken;
        } while (page && ids.length < MAX_MESSAGES);
        const found: Found[] = [];
        for (const id of ids.slice(0, MAX_MESSAGES)) {
          if (ctx.signal.aborted) break;
          const m = await s.get(`${base}/messages/${encodeURIComponent(id)}?format=full`) as { id: string; internalDate?: string; payload?: GmailPart & { headers?: { name: string; value: string }[] } };
          const header = (n: string) => m.payload?.headers?.find(h => h.name.toLowerCase() === n)?.value ?? '';
          if (!isHealthEmail(header('from'), header('subject'))) continue;
          const parts: GmailPart[] = [];
          const walk = (p?: GmailPart) => { if (!p) return; if (p.filename && p.body?.attachmentId) parts.push(p); p.parts?.forEach(walk); };
          walk(m.payload);
          for (const p of parts) {
            if (!isRecordPdf(p.filename!, p.mimeType ?? '', p.body?.size ?? 0, ctx.maxBytes)) continue;
            const a = await s.get(`${base}/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(p.body!.attachmentId!)}`) as { data?: string };
            if (!a.data) continue;
            const bytes = new Uint8Array(Buffer.from(a.data, 'base64url'));
            // Gmail's attachment ids change between requests; the message id and part are stable.
            found.push({ key: `gmail:${id}:${p.partId ?? p.filename}`, subject: header('subject'), received: Number(m.internalDate ?? now()), name: p.filename!, bytes });
          }
        }
        return found;
      });
    },
  };
}

/* ---------------- Outlook (Microsoft Graph) ---------------- */

export const OUTLOOK_AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
export const OUTLOOK_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
export const OUTLOOK_API_URL = 'https://graph.microsoft.com';

export function outlookFetcher(client: OAuthClient, opts: { apiUrl?: string; authorizeUrl?: string; tokenUrl?: string; fetch?: typeof fetch; now?: () => number } = {}): OAuthFetcher {
  const api = (opts.apiUrl ?? OUTLOOK_API_URL).replace(/\/+$/, '');
  const now = opts.now ?? Date.now;
  const session = oauthSession<MailTokens>({
    sourceId: 'outlook', device: 'Outlook',
    authorizeUrl: opts.authorizeUrl ?? OUTLOOK_AUTHORIZE_URL, tokenUrl: opts.tokenUrl ?? OUTLOOK_TOKEN_URL,
    scopes: ['offline_access', 'Mail.Read'], refreshWithScope: true,
    forbidden: 'Outlook did not share your email: your organisation may not allow apps to read mail. Ask its administrator, or use a personal account.',
  }, client, opts);
  return {
    sourceId: 'outlook',
    authorizeUrl: state => session.authorizeUrl(state),
    exchange: code => session.exchange(code),
    async run(ctx) {
      const s = await session.signIn(ctx);
      return check(ctx, 'Outlook', s, now(), async since => {
        type Msg = { id: string; subject?: string; receivedDateTime?: string; from?: { emailAddress?: { address?: string; name?: string } } };
        const msgs: Msg[] = [];
        // Graph wants the $orderby property first in $filter.
        const q = new URLSearchParams({
          $filter: `receivedDateTime ge ${new Date(since).toISOString()} and hasAttachments eq true`,
          $orderby: 'receivedDateTime desc', $select: 'id,subject,from,receivedDateTime', $top: '50',
        });
        let next: string | undefined = `${api}/v1.0/me/messages?${q}`;
        while (next && msgs.length < MAX_MESSAGES) {
          // Only follow paging links back to Graph itself.
          if (!next.startsWith(`${api}/`)) throw new PortalError('Outlook answered in an unexpected way. Try again later.');
          const b = await s.get(next) as { value?: Msg[]; '@odata.nextLink'?: string };
          msgs.push(...(b.value ?? []));
          next = b['@odata.nextLink'];
        }
        const found: Found[] = [];
        for (const m of msgs.slice(0, MAX_MESSAGES)) {
          if (ctx.signal.aborted) break;
          const addr = m.from?.emailAddress?.address ?? '';
          if (!isHealthEmail(addr, m.subject ?? '')) continue;
          const b = await s.get(`${api}/v1.0/me/messages/${encodeURIComponent(m.id)}/attachments`) as { value?: { id: string; '@odata.type'?: string; name?: string; contentType?: string; size?: number; contentBytes?: string }[] };
          for (const a of b.value ?? []) {
            if (a['@odata.type'] && a['@odata.type'] !== '#microsoft.graph.fileAttachment') continue;
            if (!a.contentBytes || !isRecordPdf(a.name ?? '', a.contentType ?? '', a.size ?? 0, ctx.maxBytes)) continue;
            found.push({ key: `outlook:${m.id}:${a.id}`, subject: m.subject ?? '', received: Date.parse(m.receivedDateTime ?? '') || now(), name: a.name!, bytes: new Uint8Array(Buffer.from(a.contentBytes, 'base64')) });
          }
        }
        return found;
      });
    },
  };
}
