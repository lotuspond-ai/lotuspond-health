// What the account holder confirms when adding a family member (Terms §4, Privacy §10). The server records it as a
// `family_profile` consent with the text version, so there is evidence of who agreed to what.
import type { FamilyConfirmation, Relationship } from './types.ts';

/** Years from a yyyy-mm-dd date of birth to today, or null. */
function age(dob: string | null | undefined, now = new Date()): number | null {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const [y, m, d] = dob.split('-').map(Number);
  let a = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) a--;
  return a;
}

/** A child, or anyone under 18 by the date of birth given: the account holder confirms they are the parent or guardian. */
export function needsGuardian(relationship: Relationship | string | undefined, dateOfBirth: string | null | undefined, now = new Date()): boolean {
  if (relationship === 'child') return true;
  const a = age(dateOfBirth, now);
  return a != null && a < 18;
}

export function confirmationFor(relationship: Relationship | string | undefined, dateOfBirth: string | null | undefined): FamilyConfirmation {
  return needsGuardian(relationship, dateOfBirth) ? 'guardian' : 'agreed';
}

/** The sentence the person ticks, as shown in the app. */
export function confirmationText(confirmation: FamilyConfirmation, name: string): string {
  const who = name.trim() || 'this person';
  return confirmation === 'guardian'
    ? `I am ${who}'s parent or legal guardian, and I consent to keeping their health records in LotusPond Health on their behalf.`
    : `${who} has agreed to me keeping their health records in LotusPond Health, and I will remove their profile if they ask.`;
}
