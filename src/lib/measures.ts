// Height and weight in US customary units. Profiles always store centimetres and kilograms; these convert entry
// and display for countries whose policy says measurement: 'us'.
export const CM_PER_INCH = 2.54;
export const KG_PER_POUND = 0.45359237;

/** Range errors in the units the person typed (the stored limits are 20–272 cm and 0.5–650 kg). */
export const IMPERIAL_ERRORS = {
  height: 'Enter a height between 8 in and 8 ft 11 in.',
  weight: 'Enter a weight between 1 and 1,430 lb.',
};

const trim = (n: number) => String(Math.round(n * 10) / 10);
/** Two decimals in the stored metric value keep a typed whole pound or inch exact after a round trip. */
const stored = (n: number) => String(Math.round(n * 100) / 100);

function parse(s: string): number | null {
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** "170.18" cm → { feet: "5", inches: "7" }. */
export function cmToFeetInches(cm: string): { feet: string; inches: string } {
  const v = parse(cm);
  if (v == null || v <= 0) return { feet: '', inches: '' };
  let feet = Math.floor(v / CM_PER_INCH / 12);
  let inches = Math.round((v / CM_PER_INCH - feet * 12) * 10) / 10;
  if (inches >= 12) { feet += 1; inches = 0; }
  return { feet: String(feet), inches: trim(inches) };
}

/** Feet and inches as typed → centimetres as a draft string ('' when both are empty or not numbers). */
export function feetInchesToCm(feet: string, inches: string): string {
  const f = parse(feet), i = parse(inches);
  if (f == null && i == null) return feet.trim() || inches.trim() ? 'invalid' : '';
  return stored(((f ?? 0) * 12 + (i ?? 0)) * CM_PER_INCH);
}

export function kgToPounds(kg: string): string {
  const v = parse(kg);
  return v == null || v <= 0 ? '' : trim(v / KG_PER_POUND);
}

export function poundsToKg(lb: string): string {
  const v = parse(lb);
  if (v == null) return lb.trim() ? 'invalid' : '';
  return stored(v * KG_PER_POUND);
}
