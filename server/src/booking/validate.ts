// Shape checks for booking API bodies. Business rules (adults only, the current consent notice, items on the
// partner's catalogue, slots in the future) are the booking service's job; this only checks form.
import type { PartnerId } from '../../../shared/lab-bundle.ts';
import { parseDeviceKey, type DevicePublicJwk } from '../crypto/keys.ts';
import type { Address, Patient, Slot } from '../partners/types.ts';

export interface BookingInput {
  partner: PartnerId;
  items: string[];
  slot: Slot;
  patient: Patient;
  address: Address;
  devicePublicKey: DevicePublicJwk;
  consent: { noticeVersion: string; accepted: boolean };
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
/** Any printable text: no control characters. Names, addresses and landmarks vary too much to police further. */
const PRINTABLE = /^[^\p{Cc}]*$/u;
const ITEM_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
export const PINCODE_RE = /^[1-9]\d{5}$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function text(o: Obj, key: string, errors: string[], min: number, max: number, required = true): string | undefined {
  const v = o[key];
  if (v == null || v === '') {
    if (required) errors.push(`${key} is required`);
    return undefined;
  }
  if (typeof v !== 'string') { errors.push(`${key} must be text`); return undefined; }
  const t = v.trim();
  if (t.length < min || t.length > max) { errors.push(`${key} must be ${min} to ${max} characters`); return undefined; }
  if (!PRINTABLE.test(t)) { errors.push(`${key} contains control characters`); return undefined; }
  return t;
}

export function parseSlot(v: unknown, errors: string[], key = 'slot'): Slot | undefined {
  if (!isObj(v)) { errors.push(`${key} must be {start, end}`); return undefined; }
  const { start, end } = v;
  if (typeof start !== 'string' || typeof end !== 'string' || !ISO_WITH_OFFSET.test(start) || !ISO_WITH_OFFSET.test(end)) {
    errors.push(`${key}.start and ${key}.end must be ISO 8601 times with an offset`);
    return undefined;
  }
  const s = Date.parse(start), e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s || e - s > 4 * 3600_000) {
    errors.push(`${key} must end after it starts, within 4 hours`);
    return undefined;
  }
  return { start, end };
}

export function parseBookingInput(body: unknown): Parsed<BookingInput> {
  const errors: string[] = [];
  if (!isObj(body)) return { ok: false, errors: ['Body must be a JSON object'] };

  const partner = typeof body.partner === 'string' && /^[a-z0-9]{1,32}$/.test(body.partner) ? body.partner as PartnerId : undefined;
  if (!partner) errors.push('partner is required');

  let items: string[] | undefined;
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 10) errors.push('items must list 1 to 10 package codes');
  else if (!body.items.every(i => typeof i === 'string' && ITEM_CODE.test(i))) errors.push('items must be package codes');
  else if (new Set(body.items).size !== body.items.length) errors.push('items must not repeat');
  else items = body.items as string[];

  const slot = parseSlot(body.slot, errors);

  let patient: Patient | undefined;
  if (!isObj(body.patient)) errors.push('patient is required');
  else {
    const name = text(body.patient, 'name', errors, 2, 100);
    const age = body.patient.age;
    if (typeof age !== 'number' || !Number.isInteger(age) || age < 0 || age > 120) errors.push('patient.age must be a whole number of years');
    const sex = body.patient.sex;
    if (sex !== 'female' && sex !== 'male' && sex !== 'other') errors.push('patient.sex must be female, male or other');
    if (name && typeof age === 'number' && (sex === 'female' || sex === 'male' || sex === 'other')) patient = { name, age, sex };
  }

  let address: Address | undefined;
  if (!isObj(body.address)) errors.push('address is required');
  else {
    const a = body.address;
    const line1 = text(a, 'line1', errors, 3, 200);
    const line2 = text(a, 'line2', errors, 1, 200, false);
    const landmark = text(a, 'landmark', errors, 1, 100, false);
    const city = text(a, 'city', errors, 2, 60);
    const pincode = typeof a.pincode === 'string' && PINCODE_RE.test(a.pincode) ? a.pincode : undefined;
    if (!pincode) errors.push('address.pincode must be a 6-digit pincode');
    if (line1 && city && pincode) address = { line1, city, pincode, ...(line2 ? { line2 } : {}), ...(landmark ? { landmark } : {}) };
  }

  const key = parseDeviceKey(body.devicePublicKey);
  if (typeof key === 'string') errors.push(key);

  let consent: BookingInput['consent'] | undefined;
  if (!isObj(body.consent) || typeof body.consent.noticeVersion !== 'string' || typeof body.consent.accepted !== 'boolean') {
    errors.push('consent must be {noticeVersion, accepted}');
  } else consent = { noticeVersion: body.consent.noticeVersion, accepted: body.consent.accepted };

  if (errors.length || !partner || !items || !slot || !patient || !address || typeof key === 'string' || !consent) return { ok: false, errors };
  return { ok: true, value: { partner, items, slot, patient, address, devicePublicKey: key, consent } };
}
