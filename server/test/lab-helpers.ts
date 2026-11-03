// Shared lab test fixtures.
import { LAB_BOOKING_NOTICE_VERSION } from '../../shared/lab-bundle.ts';
import type { Slot } from '../src/lab/partners/types.ts';

export const NOTICE_VERSION = LAB_BOOKING_NOTICE_VERSION;

/** A complete booking request as the app sends it (JSON body of POST /api/profiles/:pid/lab-orders). */
export function bookingBody(slot: Slot, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    partner: 'fake',
    items: ['FL_ESSENTIAL'],
    slot,
    patient: { name: 'Asha Rao', age: 34, sex: 'female' },
    phone: '+919812345678',
    address: { line1: '12 Lake Road', line2: 'Koramangala', city: 'Bengaluru', pincode: '560034' },
    consent: { noticeVersion: NOTICE_VERSION, accepted: true },
    ...over,
  };
}
