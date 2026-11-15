// POST /api/profiles/:pid/extract: the optional Claude read of one photographed or scanned report.
// Multipart form: `file` (JPEG, PNG, WebP or PDF), `noticeVersion` (AI_EXTRACTION_NOTICE_VERSION the person saw) and
// `consent=accepted`. Each request records an ai_extraction consent and a report_read_by_ai event, then returns the
// rows as printed. The file is not stored here: the app saves it with the results only if the person adds them.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AI_EXTRACTION_NOTICE_VERSION, type AiExtraction } from '../../../shared/types.ts';
import { eventContext, recordEvent } from '../compliance/audit.ts';
import { recordConsents } from '../compliance/consents.ts';
import { badRequest, conflict, HttpError, tooMany } from '../lib/errors.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { requireAuth, type AppEnv, type Deps } from '../http.ts';
import { requireProfile } from '../routes/profiles.ts';
import { EXTRACTION_MEDIA_TYPES, ExtractionError, type ExtractionMediaType, type ReportExtractor } from './claude.ts';

/** Claude takes images up to 5 MB; the app downsizes photos before sending. PDFs: a few scanned pages. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** Reads per account per hour. */
const PER_HOUR = 30;

/** The kind of file, from its first bytes (not the name or the browser's type). */
export function sniffMedia(b: Uint8Array): ExtractionMediaType | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'image/webp';
  if (String.fromCharCode(...b.subarray(0, 5)) === '%PDF-') return 'application/pdf';
  return null;
}

const isoDate = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : null);

export function extractionRoutes(deps: Deps, extractor: ReportExtractor) {
  const limiter = new RateLimiter(PER_HOUR, 60 * 60_000);
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(deps));
  app.use('*', requireProfile());

  app.post('/',
    bodyLimit({ maxSize: MAX_PDF_BYTES + 64 * 1024, onError: () => { throw new HttpError(413, 'too_large', 'This file is too large to send. Photos are made smaller automatically; for a PDF, send at most a few pages.'); } }),
    async c => {
      const wait = limiter.hit(c.var.user.id);
      if (wait) throw tooMany(`You have sent many reports to Claude in the last hour. Try again in ${Math.ceil(wait / 60)} minutes.`);
      let form: Record<string, string | File | (string | File)[]>;
      try { form = await c.req.parseBody(); } catch { throw badRequest('Send the file as multipart form data.'); }
      if (form.consent !== 'accepted') throw badRequest('Agree to send this report to Claude first.', 'consent_required');
      if (form.noticeVersion !== AI_EXTRACTION_NOTICE_VERSION) {
        throw conflict('The notice about reading with Claude has changed since this page was loaded. Reload the app and try again.', 'notice_outdated');
      }
      const file = form.file;
      if (!(file instanceof File) || file.size === 0) throw badRequest('Attach the report in the "file" field.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mediaType = sniffMedia(bytes);
      if (!mediaType || !EXTRACTION_MEDIA_TYPES.includes(mediaType)) throw new HttpError(415, 'unsupported', 'Send a JPEG, PNG or WebP photo, or a PDF.');
      if (mediaType !== 'application/pdf' && bytes.byteLength > MAX_IMAGE_BYTES) throw new HttpError(413, 'too_large', 'This photo is larger than 5 MB.');

      // The consent and the event are recorded before the file leaves: they describe a disclosure that happens now.
      const { db } = c.var.cell;
      const profileId = c.var.profile.id;
      await recordConsents(db, c.var.user.id, c.var.user.country, [{ kind: 'ai_extraction', granted: true, version: AI_EXTRACTION_NOTICE_VERSION, detail: { profileId } }]);
      await recordEvent(db, eventContext(c, deps), c.var.user.id, 'report_read_by_ai', { profileId });

      let out;
      try {
        out = await extractor.extract({ bytes, mediaType });
      } catch (e) {
        if (e instanceof ExtractionError) {
          throw new HttpError(e.code === 'unavailable' ? 503 : 422, e.code === 'unavailable' ? 'ai_unavailable' : 'ai_unreadable', e.message);
        }
        throw e;
      }
      const body: AiExtraction = {
        isLabReport: out.is_lab_report,
        sampleDate: isoDate(out.sample_date),
        results: out.results.slice(0, 300).map(r => ({
          name: r.name.slice(0, 200), value: r.value.slice(0, 60), unit: r.unit.slice(0, 40), range: r.range.slice(0, 80), flag: r.flag.slice(0, 20),
        })).filter(r => r.name.trim() && r.value.trim()),
      };
      return c.json(body);
    });

  return app;
}
