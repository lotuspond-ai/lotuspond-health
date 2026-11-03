// Which body the map shows: the male or the female model (tools/anatomy). Pure, so tests can import it under Node.
import type { Sex } from '../../shared/types.ts';

export type Body = 'female' | 'male';
export const BODIES: readonly Body[] = ['female', 'male'];

/** Shown when a profile's sex assigned at birth is not set or is intersex, until the person picks a body. */
export const DEFAULT_BODY: Body = 'female';

/** 'profile' follows the profile's sex; 'female' or 'male' is a choice made on this device. */
export type BodyChoice = 'profile' | Body;

export function bodyFor(sex: Sex | null | undefined, choice: BodyChoice = 'profile'): Body {
  if (choice === 'female' || choice === 'male') return choice;
  return sex === 'male' ? 'male' : sex === 'female' ? 'female' : DEFAULT_BODY;
}

export const isBody = (v: unknown): v is Body => v === 'female' || v === 'male';
