// DigiLocker through its Authorized Partner (Requester) API, run by NeGD with Meri Pehchaan sign-in. When it is set
// up it takes over from the browser for the `digilocker` source.
//
//   Sign-in  GET  https://digilocker.meripehchaan.gov.in/public/oauth2/1/authorize  response_type=code, client_id,
//                 redirect_uri, state, scope=openid, code_challenge (S256)
//   Token    POST https://digilocker.meripehchaan.gov.in/public/oauth2/2/token  code, grant_type=authorization_code,
//                 client_id, client_secret, redirect_uri, code_verifier → access_token (3600 s), id_token. Version 2.0
//                 of the specification removed refresh tokens, so every check starts on DigiLocker's page (oneTime).
//   Issued   GET  /public/oauth2/2/files/issued → { items: [{ name, date, mime, uri, doctype, description, issuerid,
//                 issuer }] }
//   Uploaded GET  /public/oauth2/1/files/[id] → { items: [{ name, type: file | dir, id, date, mime, uri }] }
//   File     GET  /public/oauth2/1/file/{uri} → the bytes, with an `hmac` header: Base64 HMAC-SHA256 of the bytes
//                 under the client secret, checked before anything is saved.
//
// Only health documents are brought in: issued documents whose type or issuer is health-related (vaccination
// certificates, health insurance policies, Ayushman / PM-JAY and ABHA cards, disability certificates, CGHS and ESIC
// cards), and the person's own uploads whose names say they are medical. Identity documents (Aadhaar, PAN, licences),
// mark sheets and the like are never downloaded.
//
// Written from the Authorized Partner API Specification v2.0 (September 2022) and tested against a copy of it
// (test/digilocker.test.ts). LotusPond needs to be registered as a DigiLocker Requester (partners.digitallocker.gov.in);
// it has not been run against the real service.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PortalError, type PortalReport } from '../recipes/types.ts';
import { oauthSession, type OAuthClient, type Tokens } from './oauth2.ts';
import type { OAuthFetcher } from './types.ts';

export const DIGILOCKER_URL = 'https://digilocker.meripehchaan.gov.in';

interface Item { name?: string; type?: string; id?: string; date?: string; mime?: unknown; uri?: string; doctype?: string; description?: string; issuerid?: string; issuer?: string }

/** Issued document types and issuers that hold health records. */
const HEALTH_ISSUED = /vaccin|covid|immuni[sz]ation|health|insurance|mediclaim|ayushman|pm-?jay|abha|disab|udid|medical|hospital|discharge|cghs|esic|e-?pehchan|blood/i;
/** Uploaded file names that say they are medical. */
const HEALTH_UPLOAD = /report|lab|test|blood|scan|x-?ray|mri|ct\b|ultrasound|ecg|prescription|discharge|medical|health|hospital|clinic|vaccin|doctor|dr\.?\s|pathology|diagnos/i;
/** Never these, whatever their names say. */
const IDENTITY = /aadhaa?r|\bpan\b|driving\s*licen|voter|passport|ration|mark\s*sheet|marksheet|degree|certificate\s+of\s+(?:class|board)|vehicle|registration\s+certificate|fitness\s+certificate|income|caste|domicile|birth/i;

export function isHealthIssued(i: Item): boolean {
  const text = `${i.description ?? ''} ${i.name ?? ''} ${i.issuer ?? ''} ${i.doctype ?? ''}`;
  return !IDENTITY.test(`${i.description ?? ''} ${i.name ?? ''}`) && HEALTH_ISSUED.test(text);
}

export function isHealthUpload(i: Item): boolean {
  return i.type === 'file' && !!i.uri && !IDENTITY.test(i.name ?? '') && HEALTH_UPLOAD.test(i.name ?? '');
}

/** The hmac header DigiLocker sends: Base64 HMAC-SHA256 of the file under the client secret. */
export function hmacOk(bytes: Uint8Array, header: string | null, secret: string): boolean {
  if (!header) return false;
  const want = createHmac('sha256', secret).update(bytes).digest();
  let got: Buffer;
  try { got = Buffer.from(header.trim(), 'base64'); } catch { return false; }
  return got.length === want.length && timingSafeEqual(got, want);
}

const day = (d?: string) => (d && /^\s*\d{4}-\d{2}-\d{2}/.test(d) ? d.trim().slice(0, 10) : null);
const wantsPdf = (mime: unknown) => JSON.stringify(mime ?? '').toLowerCase().includes('pdf');

export function digilockerFetcher(client: OAuthClient, opts: { apiUrl?: string; fetch?: typeof fetch; now?: () => number } = {}): OAuthFetcher {
  const base = (opts.apiUrl ?? DIGILOCKER_URL).replace(/\/+$/, '');
  const session = oauthSession<Tokens>({
    sourceId: 'digilocker', device: 'DigiLocker',
    authorizeUrl: `${base}/public/oauth2/1/authorize`, tokenUrl: `${base}/public/oauth2/2/token`,
    scopes: ['openid'], pkce: true, noRefresh: true,
    forbidden: 'DigiLocker did not share your documents. Approve LotusPond’s request on DigiLocker’s page and try again.',
  }, client, opts);

  return {
    sourceId: 'digilocker', oneTime: true,
    authorizeUrl: state => session.authorizeUrl(state),
    exchange: (code, state) => session.exchange(code, state),

    async run(ctx): Promise<PortalReport[]> {
      const s = await session.signIn(ctx);
      await ctx.step('Reading your DigiLocker documents');
      const issued = ((await s.get(`${base}/public/oauth2/2/files/issued`)) as { items?: Item[] }).items ?? [];
      const wanted: { item: Item; issued: boolean }[] = issued.filter(isHealthIssued).map(item => ({ item, issued: true }));

      // The person's own uploads: the root folder and its folders, two levels down.
      const walk = async (id: string | null, depth: number) => {
        const b = await s.get(`${base}/public/oauth2/1/files/${id ? encodeURIComponent(id) : ''}`) as { items?: Item[] };
        for (const i of b.items ?? []) {
          if (i.type === 'dir' && i.id && depth < 2) await walk(i.id, depth + 1);
          else if (isHealthUpload(i)) wanted.push({ item: i, issued: false });
        }
      };
      await walk(null, 0);

      const out: PortalReport[] = [];
      let tampered = 0;
      for (const { item, issued: isIssued } of wanted.slice(0, 50)) {
        if (isIssued && item.mime !== undefined && !wantsPdf(item.mime)) continue;
        const file = await s.getFile(`${base}/public/oauth2/1/file/${encodeURIComponent(item.uri!.trim())}`, ctx.maxBytes);
        // Integrity: a file whose hmac does not match is not saved.
        if (!hmacOk(file.bytes, file.headers.get('hmac'), client.clientSecret)) { tampered++; continue; }
        const title = (item.description || item.name || 'DigiLocker document').trim();
        out.push({
          key: `digilocker:${item.uri!.trim()}`, title: item.issuer ? `${title} (${item.issuer})` : title, date: day(item.date),
          fileName: `DigiLocker ${item.name ?? title}`.trim(), contentType: file.contentType, bytes: file.bytes,
        });
      }
      if (tampered) {
        if (!out.length) throw new PortalError('DigiLocker’s documents did not pass the integrity check, so none were saved. Try again later.');
        ctx.note(`${tampered} document${tampered === 1 ? '' : 's'} did not pass DigiLocker’s integrity check and ${tampered === 1 ? 'was' : 'were'} not saved.`);
      }
      return out;
    },
  };
}
