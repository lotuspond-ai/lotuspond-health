// Email (Gmail, Outlook) as a record agent source: report PDFs that labs, hospitals and pharmacies email people.
//
// The person signs in on Google's or Microsoft's page with read-only mail access. Each check:
//   1. Lists emails received since the last check (a year back the first time) that have attachments, and works
//      through them oldest first.
//   2. Keeps only health emails: from a known lab, hospital or pharmacy domain, or with a subject that names a lab
//      report, test result, prescription or discharge summary. Only headers and attachment details are fetched to
//      decide: email bodies are never downloaded (one exception: a Gmail PDF carried inline in a health email).
//   3. Downloads their PDF attachments (not bills, invoices, receipts or brochures) not already saved.
//   4. Stops at the check's report limit or after 200 emails, and moves the cursor only to the last email it
//      finished: the next check carries on from there, so a large backlog comes in over several checks.
// Many Indian labs send password-protected PDFs (the password is often derived from the name and date of birth): they
// are saved like any other, and the run notes how many there were.
//
//   Gmail    sign-in accounts.google.com/o/oauth2/v2/auth (access_type=offline, prompt=consent), token
//            oauth2.googleapis.com/token, scope gmail.readonly (a restricted scope: Google's verification and a security
//            assessment before more than 100 test users). GET gmail/v1/users/me/messages?q=… (ids, newest first),
//            messages/{id}?format=metadata (From, Subject, date), messages/{id}?format=full&fields=… (the part tree
//            without body data), messages/{id}/attachments/{attachmentId}.
//   Outlook  sign-in login.microsoftonline.com/common/oauth2/v2.0/authorize, scopes offline_access Mail.Read (personal
//            and work accounts). GET graph.microsoft.com/v1.0/me/messages?$filter=receivedDateTime ge … and
//            hasAttachments eq true&$orderby=receivedDateTime asc&$select=id,subject,from,receivedDateTime, then
//            /me/messages/{id}/attachments (contentBytes).
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

/**
 * Subjects that name a medical document (on their own, without a known sender). One list makes both the local rule
 * and Gmail's search, so the search never drops a subject the rule accepts.
 */
const SUBJECT_KINDS = ['lab', 'laboratory', 'test', 'diagnostic', 'pathology', 'blood', 'investigation', 'health check', 'health checkup', 'health check-up', 'medical', 'clinical', 'radiology', 'scan', 'x-ray', 'xray', 'mri', 'ct', 'ultrasound', 'ecg', 'echo'];
export const HEALTH_SUBJECT_PHRASES = [
  ...SUBJECT_KINDS.flatMap(k => ['report', 'reports', 'result', 'results'].map(r => `${k} ${r}`)),
  'discharge summary', 'prescription', 'report is ready', 'reports are ready',
];
const phraseRe = (p: string) => p.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '\\s*-?\\s*')).join('\\s+');
const HEALTH_SUBJECT = new RegExp(`\\b(?:${HEALTH_SUBJECT_PHRASES.map(phraseRe).join('|')})\\b`, 'i');
/** Attachments that are not records. */
const NOT_A_RECORD = /invoice|receipt|\bbill\b|\btax\b|brochure|\boffers?\b|newsletter|\bterms\b|catalog(?:ue)?|price\s*list/i;

const FIRST_DAYS = 365;
/** Emails looked at per check, at most; ids listed per check, at most (cheap: ids only). */
const MAX_MESSAGES = 200;
const MAX_LISTED = 2000;
const DAY_MS = 86_400_000;

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

function toReport(f: Found): PortalReport {
  return {
    key: f.key, title: (f.subject || f.name).slice(0, 160), date: new Date(f.received).toISOString().slice(0, 10),
    fileName: f.name.replace(/\.pdf$/i, '') || 'Report', contentType: 'application/pdf', bytes: f.bytes,
  };
}

type MailTokens = Tokens & { since?: number };

/** An email to look at: when it arrived, and how to read its health PDFs (none when it is not a health email). */
interface Candidate { received: number; reports(): Promise<Found[]> }

/**
 * What every mail check shares: oldest first, stop at the check's limits, and move the cursor only to the last email
 * finished (or to now, when every email in the window was looked at). The cursor is kept only once the reports are
 * saved (progress), so a failed save reads the same mail again.
 */
async function check(ctx: ApiContext, device: string, s: { tokens: MailTokens; progress(extra: Partial<MailTokens>): void }, now: number,
  list: (since: number) => Promise<{ candidates: Candidate[]; complete: boolean }>): Promise<PortalReport[]> {
  await ctx.step(`Looking for reports in your ${device} email`);
  // A day of overlap with the last check: an email that arrived while it ran is not missed (each is saved once).
  const since = s.tokens.since ? s.tokens.since - DAY_MS : now - FIRST_DAYS * DAY_MS;
  const { candidates, complete } = await list(since);
  const ordered = [...candidates].sort((a, b) => a.received - b.received);
  const found: Found[] = [];
  let done = 0;
  for (const c of ordered) {
    if (ctx.signal.aborted || done >= MAX_MESSAGES) break;
    const fresh = await c.reports();
    // An email whose reports would pass the limit is left whole for the next check.
    if (found.length && found.length + fresh.length > ctx.maxReports) break;
    found.push(...fresh);
    done++;
  }
  const finishedAll = complete && done === ordered.length;
  const cursor = finishedAll ? now : done ? ordered[done - 1].received + 1 : s.tokens.since ?? since + DAY_MS;
  const locked = found.filter(f => isEncryptedPdf(f.bytes)).length;
  const more = finishedAll ? '' : ' There are more emails to look at: the next check carries on from here.';
  if (locked) ctx.note(`${locked} of the reports are password-protected PDFs. Labs often use your name and date of birth as the password; open them in Files to read them.${more}`);
  else if (more) ctx.note(more.trim());
  s.progress({ since: cursor });
  return found.map(toReport);
}

/* ---------------- Gmail ---------------- */

export const GMAIL_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GMAIL_API_URL = 'https://gmail.googleapis.com';

interface GmailPart { partId?: string; filename?: string; mimeType?: string; body?: { attachmentId?: string; size?: number; data?: string }; parts?: GmailPart[] }

/** The Gmail search for health emails with PDFs since a time: a superset of the local rule, which is applied again. */
export function gmailQuery(sinceMs: number): string {
  const from = HEALTH_SENDER_DOMAINS.map(d => `from:${d}`).join(' OR ');
  const subject = `subject:(${HEALTH_SUBJECT_PHRASES.map(p => `"${p}"`).join(' OR ')})`;
  return `has:attachment filename:pdf after:${Math.floor(sinceMs / 1000)} {${from} ${subject}}`;
}

/** Gmail's partial-response fields for the part tree without any body data (five levels of nesting). */
const PART = 'partId,filename,mimeType,body(attachmentId,size)';
const nest = (n: number): string => (n ? `${PART},parts(${nest(n - 1)})` : PART);
export const GMAIL_PART_FIELDS = `id,payload(${nest(5)})`;

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
    exchange: (code, state) => session.exchange(code, state),
    async run(ctx) {
      const s = await session.signIn(ctx);
      const base = `${api}/gmail/v1/users/me`;
      const msg = (id: string, q: string) => `${base}/messages/${encodeURIComponent(id)}?${q}`;
      return check(ctx, 'Gmail', s, now(), async since => {
        // Ids only, newest first; listed in full (up to MAX_LISTED) so the oldest can go first.
        const ids: string[] = [];
        let page: string | undefined;
        do {
          const q = new URLSearchParams({ q: gmailQuery(since), maxResults: '500', ...(page ? { pageToken: page } : {}) });
          const b = await s.get(`${base}/messages?${q}`) as { messages?: { id: string }[]; nextPageToken?: string };
          ids.push(...(b.messages ?? []).map(m => m.id));
          page = b.nextPageToken;
        } while (page && ids.length < MAX_LISTED);
        const kept = ids.slice(0, MAX_LISTED);
        // Headers only (From, Subject, date): no body is downloaded to decide.
        const candidates: Candidate[] = [];
        for (const id of kept.slice().reverse().slice(0, MAX_MESSAGES)) {
          if (ctx.signal.aborted) break;
          const m = await s.get(msg(id, 'format=metadata&metadataHeaders=From&metadataHeaders=Subject')) as { internalDate?: string; payload?: { headers?: { name: string; value: string }[] } };
          const header = (n: string) => m.payload?.headers?.find(h => h.name.toLowerCase() === n)?.value ?? '';
          const subject = header('subject');
          const health = isHealthEmail(header('from'), subject);
          const received = Number(m.internalDate ?? now());
          candidates.push({
            received,
            reports: async () => {
              if (!health) return [];
              // The part tree, without body data.
              const tree = await s.get(msg(id, `format=full&fields=${encodeURIComponent(GMAIL_PART_FIELDS)}`)) as { payload?: GmailPart };
              const parts: GmailPart[] = [];
              const walk = (p?: GmailPart) => { if (!p) return; if (p.filename) parts.push(p); p.parts?.forEach(walk); };
              walk(tree.payload);
              const out: Found[] = [];
              let inline: GmailPart | null | undefined;
              for (const p of parts) {
                if (!isRecordPdf(p.filename!, p.mimeType ?? '', p.body?.size ?? 0, ctx.maxBytes)) continue;
                // Gmail's attachment ids change between requests; the message id and part are stable.
                const key = `gmail:${id}:${p.partId ?? p.filename}`;
                if (await ctx.alreadySaved(key)) continue;
                let data: string | undefined;
                if (p.body?.attachmentId) {
                  data = (await s.get(`${base}/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(p.body.attachmentId)}`) as { data?: string }).data;
                } else {
                  // A PDF carried inline: only then is this health email fetched with its data, and only this part kept.
                  if (inline === undefined) inline = (await s.get(msg(id, 'format=full')) as { payload?: GmailPart }).payload ?? null;
                  const find = (q?: GmailPart | null): GmailPart | undefined => (!q ? undefined : q.partId === p.partId && q.filename === p.filename ? q : q.parts?.map(find).find(Boolean));
                  data = find(inline)?.body?.data;
                }
                if (data) out.push({ key, subject, received, name: p.filename!, bytes: new Uint8Array(Buffer.from(data, 'base64url')) });
              }
              return out;
            },
          });
        }
        return { candidates, complete: !page && ids.length <= MAX_MESSAGES };
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
    exchange: (code, state) => session.exchange(code, state),
    async run(ctx) {
      const s = await session.signIn(ctx);
      return check(ctx, 'Outlook', s, now(), async since => {
        type Msg = { id: string; subject?: string; receivedDateTime?: string; from?: { emailAddress?: { address?: string } } };
        const msgs: Msg[] = [];
        // Oldest first; Graph wants the $orderby property first in $filter. No body is selected.
        const q = new URLSearchParams({
          $filter: `receivedDateTime ge ${new Date(since).toISOString()} and hasAttachments eq true`,
          $orderby: 'receivedDateTime asc', $select: 'id,subject,from,receivedDateTime', $top: '50',
        });
        let next: string | undefined = `${api}/v1.0/me/messages?${q}`;
        while (next && msgs.length < MAX_MESSAGES) {
          // Only follow paging links back to Graph itself.
          if (!next.startsWith(`${api}/`)) throw new PortalError('Outlook answered in an unexpected way. Try again later.');
          const b = await s.get(next) as { value?: Msg[]; '@odata.nextLink'?: string };
          msgs.push(...(b.value ?? []));
          next = b['@odata.nextLink'];
        }
        const candidates: Candidate[] = msgs.slice(0, MAX_MESSAGES).map(m => {
          const received = Date.parse(m.receivedDateTime ?? '') || now();
          const health = isHealthEmail(m.from?.emailAddress?.address ?? '', m.subject ?? '');
          return {
            received,
            reports: async () => {
              if (!health) return [];
              const b = await s.get(`${api}/v1.0/me/messages/${encodeURIComponent(m.id)}/attachments`) as { value?: { id: string; '@odata.type'?: string; name?: string; contentType?: string; size?: number; contentBytes?: string }[] };
              const out: Found[] = [];
              for (const a of b.value ?? []) {
                if (a['@odata.type'] && a['@odata.type'] !== '#microsoft.graph.fileAttachment') continue;
                if (!a.contentBytes || !isRecordPdf(a.name ?? '', a.contentType ?? '', a.size ?? 0, ctx.maxBytes)) continue;
                const key = `outlook:${m.id}:${a.id}`;
                if (await ctx.alreadySaved(key)) continue;
                out.push({ key, subject: m.subject ?? '', received, name: a.name!, bytes: new Uint8Array(Buffer.from(a.contentBytes, 'base64')) });
              }
              return out;
            },
          };
        });
        return { candidates, complete: !next && msgs.length <= MAX_MESSAGES };
      });
    },
  };
}
