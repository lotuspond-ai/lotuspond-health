// Request shapes for lab booking (design doc §7), validated with Zod like the rest of the API (src/schemas.ts).
// Business rules (adults only, the current notice, items on the partner's catalogue, a future slot) are the booking
// service's job; these only check form.
import { z } from 'zod';
import type { PartnerId } from '../../../../shared/lab-bundle.ts';
import type { Address, Patient, Slot } from '../partners/types.ts';

export const PINCODE_RE = /^[1-9]\d{5}$/;
/** Indian mobile numbers in E.164; the partners we book with only take these. */
export const MOBILE_RE = /^\+91[6-9]\d{9}$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Any printable text: names, addresses and landmarks vary too much to police further. */
const printable = (min: number, max: number, label: string) =>
  z.string({ error: `Enter ${label}.` }).trim().min(min, `Enter ${label}.`).max(max, `Use at most ${max} characters.`)
    .refine(s => !/\p{Cc}/u.test(s), 'Remove control characters.');

export const SlotBody = z.object({
  start: z.string().regex(ISO_WITH_OFFSET, 'Use an ISO 8601 time with an offset.'),
  end: z.string().regex(ISO_WITH_OFFSET, 'Use an ISO 8601 time with an offset.'),
}, { error: 'Choose a collection slot.' }).refine(s => {
  const a = Date.parse(s.start), b = Date.parse(s.end);
  return !Number.isNaN(a) && !Number.isNaN(b) && b > a && b - a <= 4 * 3600_000;
}, 'A slot ends after it starts, within 4 hours.');

export const LabOrderCreateBody = z.object({
  partner: z.string().regex(/^[a-z0-9]{1,32}$/, 'Choose a lab.'),
  items: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'Use package codes from the catalogue.'))
    .min(1, 'Choose at least one package.').max(10, 'Choose at most 10 packages.')
    .refine(a => new Set(a).size === a.length, 'Each package once.'),
  slot: SlotBody,
  patient: z.object({
    name: printable(2, 100, 'the name the lab should use'),
    age: z.number({ error: 'Enter the age in years.' }).int('Enter the age in whole years.').min(0).max(120),
    sex: z.enum(['female', 'male', 'other'], { error: 'Choose female, male or other.' }),
  }),
  /** The number the collector calls. Accounts are email-based, so it's asked for at booking. */
  phone: z.string().trim().regex(MOBILE_RE, 'Enter an Indian mobile number as +91 followed by 10 digits.'),
  address: z.object({
    line1: printable(3, 200, 'the address'),
    line2: printable(1, 200, 'the second line').optional(),
    landmark: printable(1, 100, 'a landmark').optional(),
    city: printable(2, 60, 'the city'),
    pincode: z.string().trim().regex(PINCODE_RE, 'Enter a 6-digit pincode.'),
  }),
  consent: z.object({ noticeVersion: z.string().min(1).max(40), accepted: z.boolean() }, { error: 'Answer the consent question.' }),
}).strict();

export type BookingInput = Omit<z.output<typeof LabOrderCreateBody>, 'partner' | 'slot' | 'patient' | 'address'> & {
  partner: PartnerId;
  slot: Slot;
  patient: Patient;
  address: Address;
};

export const LabCancelBody = z.object({ reason: z.string().trim().max(200).optional() }).strict();
export const LabRescheduleBody = z.object({ slot: SlotBody }).strict();
