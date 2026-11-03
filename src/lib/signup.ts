// Sign-up form state for the residence, age and consent questions, and the checks run before sending.
// The rules themselves are shared with the server: shared/regions.ts signUpProblem().
import { countryPolicy, signUpProblem, type DataRegion, type SignUpChoices, type SignUpProblem } from '../../shared/regions';

export interface SignUpDraft {
  country: string;
  /** Answer to "Are you 18 or older?"; empty until answered. */
  age: '' | 'yes' | 'no';
  termsAndPrivacy: boolean;
  healthData: boolean;
  crossBorder: boolean;
  marketing: boolean;
}

export const emptySignUp = (country: string | null): SignUpDraft => ({
  country: country ?? '', age: '', termsAndPrivacy: false, healthData: false, crossBorder: false, marketing: false,
});

export function toChoices(d: SignUpDraft): SignUpChoices {
  const policy = d.country ? countryPolicy(d.country) : null;
  return {
    country: d.country,
    ageConfirmed: d.age === 'yes',
    consents: { termsAndPrivacy: d.termsAndPrivacy, healthData: d.healthData, crossBorder: !!policy?.crossBorder && d.crossBorder, marketing: d.marketing },
  };
}

/** The first thing to fix before sign-up can be sent, or null. */
export function checkSignUp(d: SignUpDraft, servedRegions: readonly DataRegion[]): SignUpProblem | null {
  const problem = signUpProblem(toChoices(d), servedRegions);
  if (problem?.code === 'under_age' && d.age === '') {
    return { ...problem, message: `Tell us whether you are ${countryPolicy(d.country).minAge} or older.` };
  }
  return problem;
}

/** True when nothing the person can tick would allow sign-up: the country is not offered here, or they are under age. */
export function signUpBlocked(d: SignUpDraft, servedRegions: readonly DataRegion[]): boolean {
  if (!d.country) return false;
  const p = countryPolicy(d.country);
  return !p.available || !servedRegions.includes(p.region) || d.age === 'no';
}
