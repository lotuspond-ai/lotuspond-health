// Request helpers shared by the facilities and geo routes: query validation, language, provider errors.
import { z } from 'zod';
import { badRequest } from '../lib/errors.ts';
import type { Ctx } from '../http.ts';
import { FacilityError } from './errors.ts';

const NUMBER = /^-?\d{1,3}(\.\d{1,12})?$/;

export const coordinateParam = (what: string, min: number, max: number) =>
  z.string({ error: `${what} is required.` }).trim().regex(NUMBER, `${what} must be a number.`).transform(Number)
    .pipe(z.number().min(min, `${what} must be between ${min} and ${max}.`).max(max, `${what} must be between ${min} and ${max}.`));

export const latParam = coordinateParam('Latitude', -90, 90);
export const lonParam = coordinateParam('Longitude', -180, 180);

/** Validate the query string; problems become a 400 naming the parameter. */
export function readQuery<S extends z.ZodType>(c: Ctx, schema: S): z.output<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.filter(p => typeof p === 'string').at(-1);
    throw badRequest(issue ? `${field ? `${String(field)}: ` : ''}${issue.message}` : 'The request was not valid.', 'invalid');
  }
  return parsed.data;
}

/** First language from Accept-Language ("en-IN,en;q=0.9" → "en-IN"), for place names. */
export function requestLanguage(c: Ctx): string {
  const first = c.req.header('accept-language')?.split(',')[0]?.split(';')[0]?.trim() ?? '';
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(first) ? first : 'en';
}

/** Provider problems answer 503 with a message the interface shows as is; anything else is rethrown. */
/** A 503 the interface can show. `subject` names the feature in the message ("Area search" for the geocoder). */
export function unavailable(c: Ctx, e: unknown, subject = 'Nearby search'): Response {
  if (!(e instanceof FacilityError)) throw e;
  c.header('Retry-After', e.code === 'busy' ? '5' : '60');
  return c.json({ error: { code: e.code, message: e.message.replace(/^Nearby search/, subject) } }, 503);
}
