// Where people's records are stored and which rules apply, by country. Used by sign-up, storage routing,
// unit defaults and the Trust page. Sources and reasoning: docs/research.md. Legal review is still required
// before launch in each market; this table encodes the product's policy, not legal advice.

/** Data-residency cells. Each cell is a separate database and file store, deployed in its own location. */
export type DataRegion = 'in' | 'eu' | 'us' | 'global';

export interface RegionInfo {
  id: DataRegion;
  name: string;
  /** Plain description of where records live, shown before sign-up. */
  storage: string;
}

export const REGIONS: Record<DataRegion, RegionInfo> = {
  in: { id: 'in', name: 'India', storage: 'servers in India' },
  eu: { id: 'eu', name: 'Europe', storage: 'servers in the European Union' },
  us: { id: 'us', name: 'United States', storage: 'servers in the United States' },
  global: { id: 'global', name: 'International', storage: 'our international servers' },
};

export type UnitSystem = 'conventional' | 'si';

export interface CountryPolicy {
  /** ISO 3166-1 alpha-2. */
  code: string;
  region: DataRegion;
  /** Sign-up is offered. */
  available: boolean;
  /** Why sign-up is not offered yet; shown to the person. */
  unavailableReason?: string;
  /** Data-protection laws that apply to people in this country. */
  laws: string[];
  /** Minimum age to hold an account. Younger people are added by a parent or guardian as a family profile. */
  minAge: number;
  /** Default units for lab values (people can change this). */
  units: UnitSystem;
  /** Height and weight entry. */
  measurement: 'metric' | 'us';
  /** Booking with partner labs is offered. */
  partnerLabs: boolean;
  /** Records are stored outside the person's country, so sign-up says where and asks them to agree. */
  crossBorder: boolean;
  /** A named grievance contact must be published (India, DPDP Act). */
  grievanceOfficer: boolean;
}

/** Every ISO 3166-1 alpha-2 code. Names come from Intl.DisplayNames in the reader's language. */
export const COUNTRY_CODES: readonly string[] = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT ' +
  'MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG ' +
  'UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

const EU_EEA = new Set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO'.split(' '));
/** EU outermost regions and dependencies that follow EU data law. */
const EU_TERRITORIES = new Set('AX GF GP MQ RE YT MF BL PM'.split(' '));
/** Lab results are commonly reported in SI units (mmol/L) here; elsewhere conventional units (mg/dL) are the default. */
const SI_DEFAULT = new Set('GB IE NL SE NO DK FI IS CH CA AU NZ ZA SG MY HK CN'.split(' '));
/** Imperial height and weight. */
const US_MEASURES = new Set('US LR MM PR GU VI AS MP UM'.split(' '));

const UNAVAILABLE: Record<string, string> = {
  AE: 'Health data of people in the UAE must be stored inside the UAE (Federal Law No. 2 of 2019). LotusPond Health will open here once hosting in the UAE is in place.',
  SA: 'Saudi rules on health data generally require hosting inside the Kingdom. LotusPond Health will open here once hosting in Saudi Arabia is in place.',
  CN: 'China requires security assessments before health data leaves the country (PIPL). LotusPond Health is not available here yet.',
  RU: 'Russian law requires personal data of citizens to be stored in Russia (Federal Law 242-FZ). LotusPond Health is not available here yet.',
  IR: 'LotusPond Health is not available in this country.',
  KP: 'LotusPond Health is not available in this country.',
  SY: 'LotusPond Health is not available in this country.',
  CU: 'LotusPond Health is not available in this country.',
};

/** Main data-protection law by country, for countries outside the India, Europe and US cells. */
const LOCAL_LAWS: Record<string, string[]> = {
  AU: ['Privacy Act 1988 (Australian Privacy Principles)'],
  NZ: ['Privacy Act 2020', 'Health Information Privacy Code 2020'],
  SG: ['Personal Data Protection Act 2012'],
  MY: ['Personal Data Protection Act 2010'],
  JP: ['Act on the Protection of Personal Information (APPI)'],
  KR: ['Personal Information Protection Act (PIPA)'],
  TH: ['Personal Data Protection Act B.E. 2562'],
  PH: ['Data Privacy Act of 2012'],
  ID: ['Personal Data Protection Law (Law No. 27 of 2022)'],
  VN: ['Decree 13/2023 on Personal Data Protection'],
  HK: ['Personal Data (Privacy) Ordinance'],
  TW: ['Personal Data Protection Act'],
  BR: ['Lei Geral de Proteção de Dados (LGPD)'],
  MX: ['Federal Law on Protection of Personal Data Held by Private Parties'],
  AR: ['Personal Data Protection Law 25,326'],
  CL: ['Law 19,628 on the Protection of Private Life', 'Law 21,719 (personal data protection)'],
  CO: ['Statutory Law 1581 of 2012'],
  PE: ['Personal Data Protection Law 29733'],
  ZA: ['Protection of Personal Information Act (POPIA)'],
  NG: ['Nigeria Data Protection Act 2023'],
  KE: ['Data Protection Act 2019'],
  EG: ['Personal Data Protection Law No. 151 of 2020'],
  IL: ['Protection of Privacy Law 5741-1981'],
  TR: ['Law No. 6698 on the Protection of Personal Data (KVKK)'],
  QA: ['Law No. 13 of 2016 on Personal Data Privacy'],
  BH: ['Personal Data Protection Law No. 30 of 2018'],
  OM: ['Personal Data Protection Law (Royal Decree 6/2022)'],
  KW: ['Data Privacy Protection Regulation'],
  PK: ['Prevention of Electronic Crimes Act 2016'],
  BD: ['Digital Security laws of Bangladesh'],
  LK: ['Personal Data Protection Act No. 9 of 2022'],
  NP: ['Individual Privacy Act 2018'],
};

const GLOBAL_DEFAULT_LAW = 'Local data-protection law';

/** The policy for a country code (case-insensitive). Unknown codes get the international defaults. */
export function countryPolicy(code: string): CountryPolicy {
  const c = code.trim().toUpperCase();
  const base = {
    code: c,
    available: !UNAVAILABLE[c],
    unavailableReason: UNAVAILABLE[c],
    minAge: 18,
    units: (SI_DEFAULT.has(c) ? 'si' : 'conventional') as UnitSystem,
    measurement: (US_MEASURES.has(c) ? 'us' : 'metric') as 'metric' | 'us',
    partnerLabs: false,
    grievanceOfficer: false,
  };
  if (c === 'IN') {
    return { ...base, region: 'in', laws: ['Digital Personal Data Protection Act, 2023', 'Digital Personal Data Protection Rules, 2025'], partnerLabs: true, crossBorder: false, grievanceOfficer: true };
  }
  if (EU_EEA.has(c) || EU_TERRITORIES.has(c)) {
    return { ...base, region: 'eu', laws: ['General Data Protection Regulation (GDPR)', 'European Health Data Space Regulation (from 2027)'], crossBorder: false };
  }
  if (c === 'GB' || c === 'GG' || c === 'JE' || c === 'IM') {
    return { ...base, region: 'eu', laws: ['UK GDPR', 'Data Protection Act 2018'], crossBorder: true };
  }
  if (c === 'CH') {
    return { ...base, region: 'eu', laws: ['Federal Act on Data Protection (revFADP)'], crossBorder: true };
  }
  if (c === 'US' || c === 'PR' || c === 'GU' || c === 'VI' || c === 'AS' || c === 'MP' || c === 'UM') {
    return {
      ...base, region: 'us', crossBorder: false,
      laws: ['FTC Health Breach Notification Rule (16 CFR Part 318)', 'State consumer health data laws, such as the Washington My Health My Data Act', 'California CCPA/CPRA and CMIA'],
    };
  }
  if (c === 'CA') {
    return { ...base, region: 'us', crossBorder: true, laws: ['PIPEDA', 'Provincial health privacy laws, such as Ontario PHIPA', 'Quebec Law 25'] };
  }
  return { ...base, region: 'global', crossBorder: true, laws: LOCAL_LAWS[c] ?? [GLOBAL_DEFAULT_LAW] };
}

export function isCountryCode(code: string): boolean {
  return COUNTRY_CODES.includes(code.trim().toUpperCase());
}

/** Country name in the reader's language, falling back to the code. */
export function countryName(code: string, locale?: string): string {
  try {
    return new Intl.DisplayNames(locale ? [locale] : undefined, { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** Version of the consent texts. Bump when Terms, Privacy or the health-data consent change materially. */
export const CONSENT_VERSION = '2026-11-11.3';

/** What changed in the texts at CONSENT_VERSION, for the notice that asks people to accept them (src/App.tsx). */
export const CONSENT_CHANGE_SUMMARY = 'It now covers AI agents you connect, reading a hard-to-read report photo with Claude when you choose it for that file, importing readings from Apple Health or Health Connect in the apps, and the LotusPond assistant, which sends what it needs to Anthropic only after you turn it on.';

/** English names that take "the" inside a sentence ("records for people in the United Kingdom"). */
const WITH_THE = new Set('AE AX BS CC CF CK DO FK FO GB GM GS HM IM IO KM KY MH MP MV NL PH PN SB SC TC TF UM US VG VI'.split(' '));

/** The country's English name as it reads inside a sentence, with "the" where English uses it. */
export function countryInSentence(code: string): string {
  const name = countryName(code, 'en');
  return WITH_THE.has(code.trim().toUpperCase()) ? `the ${name}` : name;
}

/** Where an account's records are kept, as a sentence. */
export function storageSentence(region: DataRegion): string {
  return `Your records are stored on ${REGIONS[region].storage}.`;
}

export interface SignUpChoices {
  country: string;
  ageConfirmed: boolean;
  consents: { termsAndPrivacy: boolean; healthData: boolean; crossBorder: boolean; marketing: boolean };
}

export interface SignUpProblem {
  code: 'country_required' | 'country_unavailable' | 'region_not_served' | 'under_age' | 'consent_required';
  field: 'country' | 'age' | 'termsAndPrivacy' | 'healthData' | 'crossBorder';
  message: string;
}

/**
 * The first reason this person cannot sign up yet, or null. The sign-up form, the API server and the browser
 * preview all apply these same rules, in this order.
 */
export function signUpProblem(input: SignUpChoices, servedRegions: readonly DataRegion[]): SignUpProblem | null {
  if (!input.country || !isCountryCode(input.country)) {
    return { code: 'country_required', field: 'country', message: 'Choose the country you live in.' };
  }
  const policy = countryPolicy(input.country);
  const name = countryInSentence(policy.code);
  if (!policy.available) {
    return { code: 'country_unavailable', field: 'country', message: policy.unavailableReason ?? 'LotusPond Health is not available in this country yet.' };
  }
  if (!servedRegions.includes(policy.region)) {
    return {
      code: 'region_not_served', field: 'country',
      message: `LotusPond Health keeps records for people in ${name} on ${REGIONS[policy.region].storage}. This server does not store records there, so it cannot create your account.`,
    };
  }
  if (!input.ageConfirmed) {
    return {
      code: 'under_age', field: 'age',
      message: `You need to be ${policy.minAge} or older to have your own account. A parent or guardian can add you as a family member on their account.`,
    };
  }
  if (!input.consents.termsAndPrivacy) {
    return { code: 'consent_required', field: 'termsAndPrivacy', message: 'Agree to the Terms and the Privacy Policy to create an account.' };
  }
  if (!input.consents.healthData) {
    return { code: 'consent_required', field: 'healthData', message: 'LotusPond needs your consent to keep your health records. Without it, it cannot create your account.' };
  }
  if (policy.crossBorder && !input.consents.crossBorder) {
    return { code: 'consent_required', field: 'crossBorder', message: `Agree to your records being stored on ${REGIONS[policy.region].storage} to create an account.` };
  }
  return null;
}
