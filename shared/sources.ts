// Where a family's health records live, and how LotusPond can bring them in (docs/record-agent.md).
//
// Each source says what it holds and how it is reached:
//   browser  the record agent opens the portal in its own browser, signs in with the person (they type the OTP or
//            password into LotusPond, which passes it to that browser and never stores it) and downloads reports;
//   abdm     through the person's ABHA and an ABDM consent request (not built yet; ABHA app exports can be uploaded);
//   api      an official API with the person's sign-in (OAuth), once we have a partnership or developer access;
//   app      already handled elsewhere in LotusPond (Apple Health / Health Connect import, WhatsApp).
//
// Host names are where the agent's browser may go for that source: everything else is blocked. They are the
// portals' public addresses as of November 2026; check them before switching a source on in production.
import type { DataRegion } from './regions.ts';

export type SourceCategory = 'government' | 'lab' | 'hospital' | 'pharmacy' | 'insurance' | 'wearable' | 'inbox';
export type SourceAccess = 'browser' | 'abdm' | 'api' | 'app';
/** How the person proves it's them on the portal. */
export type SourceSignIn = 'otp' | 'password' | 'abha' | 'oauth' | 'none';

export interface SourceInfo {
  id: string;
  name: string;
  category: SourceCategory;
  /** Data regions whose accounts can use it. */
  regions: DataRegion[];
  /** What it usually holds, in a few words each. */
  holds: string[];
  access: SourceAccess;
  signIn: SourceSignIn;
  /** Where the agent's browser may go (browser sources). Subdomains are included; an entry with a path allows only that path on that exact host. */
  hosts?: string[];
  /** The page the agent starts on. */
  startUrl?: string;
  /** Shown under the name, e.g. what to expect or why it is not available yet. */
  note?: string;
}

export const SOURCE_CATEGORY_TEXT: Record<SourceCategory, { title: string; detail: string }> = {
  government: { title: 'Government', detail: 'ABHA, DigiLocker, Ayushman Bharat, CGHS, ESIC and state schemes' },
  lab: { title: 'Labs', detail: 'Reports from diagnostic chains and their apps' },
  hospital: { title: 'Hospitals', detail: 'Discharge summaries, prescriptions and reports from patient portals' },
  pharmacy: { title: 'Pharmacies and health apps', detail: 'Prescriptions, orders and lab reports booked through them' },
  insurance: { title: 'Insurance', detail: 'Policies, e-cards, claims and health check-ups' },
  wearable: { title: 'Devices and wearables', detail: 'Steps, sleep, heart rate, glucose and weight' },
  inbox: { title: 'Messages and email', detail: 'Reports sent to you on WhatsApp or by email' },
};

export const SOURCE_ACCESS_TEXT: Record<SourceAccess, string> = {
  browser: 'The record agent signs in with you and downloads your reports',
  abdm: 'Through your ABHA, with an ABDM consent request',
  api: 'Through the official API, signing in with that service',
  app: 'Already in LotusPond',
};

const IN: DataRegion[] = ['in'];
const ALL: DataRegion[] = ['in', 'eu', 'us', 'global'];

/** The simulated portal served by this server in development and tests (records/demo-portal.ts). */
export const DEMO_SOURCE_ID = 'demo-lab';

export const SOURCES: SourceInfo[] = [
  /* ---------------- government ---------------- */
  { id: 'abha', name: 'ABHA (Ayushman Bharat Health Account)', category: 'government', regions: IN, access: 'abdm', signIn: 'abha',
    holds: ['Records linked by hospitals, labs and government programmes', 'Prescriptions', 'Discharge summaries', 'Vaccinations'],
    note: 'Needs LotusPond to be registered as an ABDM health information user. Until then, export FHIR records from your ABHA app and upload them.' },
  { id: 'digilocker', name: 'DigiLocker', category: 'government', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['digilocker.gov.in', 'meripehchaan.gov.in'], startUrl: 'https://www.digilocker.gov.in/',
    holds: ['Vaccination certificates', 'Health insurance documents issued to DigiLocker', 'Disability and other certificates'] },
  { id: 'pmjay', name: 'Ayushman Bharat PM-JAY', category: 'government', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['beneficiary.nha.gov.in', 'pmjay.gov.in'], startUrl: 'https://beneficiary.nha.gov.in/',
    holds: ['Ayushman card', 'Family members on the card', 'Hospital treatment history'] },
  { id: 'cghs', name: 'CGHS', category: 'government', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['cghs.mohfw.gov.in', 'cghs.gov.in'], startUrl: 'https://cghs.mohfw.gov.in/',
    holds: ['CGHS card and dependants', 'Appointments', 'Medicines issued', 'Referrals'] },
  { id: 'esic', name: 'ESIC', category: 'government', regions: IN, access: 'browser', signIn: 'password',
    hosts: ['esic.gov.in', 'esic.in'], startUrl: 'https://www.esic.gov.in/',
    holds: ['e-Pehchan card', 'Family details', 'Treatment and benefit history'] },
  { id: 'esanjeevani', name: 'eSanjeevani', category: 'government', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['esanjeevani.mohfw.gov.in'], startUrl: 'https://esanjeevani.mohfw.gov.in/',
    holds: ['Teleconsultation prescriptions'] },
  { id: 'cowin', name: 'CoWIN', category: 'government', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['cowin.gov.in'], startUrl: 'https://www.cowin.gov.in/',
    holds: ['COVID-19 vaccination certificates'] },
  { id: 'state-scheme', name: 'State health schemes (Aarogyasri, MJPJAY, CMCHIS and others)', category: 'government', regions: IN, access: 'browser', signIn: 'otp',
    holds: ['Scheme card', 'Treatment history'], note: 'Each state runs its own portal; the agent needs the address of yours.' },

  /* ---------------- labs ---------------- */
  { id: 'drlal', name: 'Dr Lal PathLabs', category: 'lab', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['lalpathlabs.com'], startUrl: 'https://www.lalpathlabs.com/', holds: ['Lab reports', 'Past bookings'],
    note: 'Signs in with your mobile number and the OTP Dr Lal sends, then downloads the reports on your orders.' },
  { id: 'thyrocare', name: 'Thyrocare', category: 'lab', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['thyrocare.com'], startUrl: 'https://www.thyrocare.com/', holds: ['Lab reports', 'Aarogyam packages'],
    note: 'Signs in with your mobile number and an OTP (or your Thyrocare password). The first time, Thyrocare may ask for the barcode on a report.' },
  { id: 'metropolis', name: 'Metropolis Healthcare', category: 'lab', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['metropolisindia.com'], startUrl: 'https://www.metropolisindia.com/', holds: ['Lab reports', 'Past bookings'],
    note: 'Signs in with your mobile number and the 4-digit OTP Metropolis sends, then downloads your reports.' },
  { id: 'agilus', name: 'Agilus Diagnostics (formerly SRL)', category: 'lab', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['agilusdiagnostics.com'], startUrl: 'https://www.agilusdiagnostics.com/', holds: ['Lab reports'] },
  { id: 'redcliffe', name: 'Redcliffe Labs', category: 'lab', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['redcliffelabs.com'], startUrl: 'https://redcliffelabs.com/', holds: ['Lab reports', 'Home collection bookings'] },
  { id: 'healthians', name: 'Healthians', category: 'lab', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['healthians.com'], startUrl: 'https://www.healthians.com/', holds: ['Lab reports', 'Smart reports'] },
  { id: 'orange-health', name: 'Orange Health', category: 'lab', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['orangehealth.in'], startUrl: 'https://www.orangehealth.in/', holds: ['Lab reports'] },
  { id: 'neuberg', name: 'Neuberg Diagnostics', category: 'lab', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['neubergdiagnostics.com'], startUrl: 'https://www.neubergdiagnostics.com/', holds: ['Lab reports'] },
  { id: 'vijaya', name: 'Vijaya Diagnostic Centre', category: 'lab', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['vijayadiagnostic.com'], startUrl: 'https://www.vijayadiagnostic.com/', holds: ['Lab reports', 'Imaging reports'] },
  { id: 'pathkind', name: 'Pathkind Labs', category: 'lab', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['pathkindlabs.com'], startUrl: 'https://www.pathkindlabs.com/', holds: ['Lab reports'] },
  { id: 'other-lab', name: 'Another lab’s report portal', category: 'lab', regions: ALL, access: 'browser', signIn: 'otp',
    holds: ['Lab reports'], note: 'Give the agent the portal’s address; it works out the sign-in with you.' },

  /* ---------------- hospitals ---------------- */
  { id: 'apollo', name: 'Apollo Hospitals (Apollo 24|7)', category: 'hospital', regions: IN, access: 'browser', signIn: 'otp',
    // Seen live: Apollo signs people in with Firebase (its token checks only, not the rest of googleapis.com), and
    // serves health record files from Apollo Prism (its record downloads only).
    hosts: ['apollo247.com', 'apollo247.in', 'apollohospitals.com', 'base.apolloprism.com/247/healthRecords/', 'www.googleapis.com/identitytoolkit/', 'securetoken.googleapis.com'], startUrl: 'https://www.apollo247.com/guest-health-records',
    holds: ['Lab reports', 'Prescriptions', 'Discharge summaries', 'Consultations'],
    note: 'Signs in with your mobile number and OTP, then downloads the recent documents in Apollo Health Records (Apollo Hospitals, Diagnostics, Clinics and 24|7). Older ones are in the Apollo app only.' },
  { id: 'fortis', name: 'Fortis Healthcare', category: 'hospital', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['fortishealthcare.com'], startUrl: 'https://www.fortishealthcare.com/', holds: ['Reports', 'Discharge summaries', 'Bills'] },
  { id: 'max', name: 'Max Healthcare', category: 'hospital', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['maxhealthcare.in'], startUrl: 'https://www.maxhealthcare.in/', holds: ['Reports', 'Discharge summaries'] },
  { id: 'manipal', name: 'Manipal Hospitals', category: 'hospital', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['manipalhospitals.com'], startUrl: 'https://www.manipalhospitals.com/', holds: ['Reports', 'Prescriptions'] },
  { id: 'narayana', name: 'Narayana Health', category: 'hospital', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['narayanahealth.org'], startUrl: 'https://www.narayanahealth.org/', holds: ['Reports', 'Discharge summaries'] },
  { id: 'aiims-ors', name: 'AIIMS and government hospitals (ORS)', category: 'hospital', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['ors.gov.in'], startUrl: 'https://ors.gov.in/', holds: ['Appointments', 'Lab reports where the hospital publishes them'] },
  { id: 'other-hospital', name: 'Another hospital’s patient portal', category: 'hospital', regions: ALL, access: 'browser', signIn: 'otp',
    holds: ['Reports', 'Discharge summaries'], note: 'Give the agent the portal’s address.' },

  /* ---------------- pharmacies and health apps ---------------- */
  { id: 'tata-1mg', name: 'Tata 1mg', category: 'pharmacy', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['1mg.com'], startUrl: 'https://www.1mg.com/', holds: ['Lab reports booked on 1mg', 'Prescriptions', 'Medicine orders'] },
  { id: 'pharmeasy', name: 'PharmEasy', category: 'pharmacy', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['pharmeasy.in'], startUrl: 'https://pharmeasy.in/', holds: ['Lab reports booked on PharmEasy', 'Prescriptions', 'Medicine orders'] },
  { id: 'apollo-pharmacy', name: 'Apollo Pharmacy', category: 'pharmacy', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['apollopharmacy.in', 'apollo247.com'], startUrl: 'https://www.apollopharmacy.in/', holds: ['Prescriptions', 'Medicine orders'] },
  { id: 'netmeds', name: 'Netmeds', category: 'pharmacy', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['netmeds.com'], startUrl: 'https://www.netmeds.com/', holds: ['Prescriptions', 'Medicine orders'] },
  { id: 'practo', name: 'Practo', category: 'pharmacy', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['practo.com'], startUrl: 'https://www.practo.com/', holds: ['Consultations', 'Prescriptions', 'Lab reports'] },
  { id: 'eka-care', name: 'Eka Care', category: 'pharmacy', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['eka.care'], startUrl: 'https://www.eka.care/', holds: ['Records you stored in Eka', 'Prescriptions from Eka clinics'] },

  /* ---------------- insurance ---------------- */
  { id: 'star-health', name: 'Star Health', category: 'insurance', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['starhealth.in'], startUrl: 'https://www.starhealth.in/', holds: ['Policy and e-card', 'Claims', 'Health check-up reports'] },
  { id: 'hdfc-ergo', name: 'HDFC ERGO', category: 'insurance', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['hdfcergo.com'], startUrl: 'https://www.hdfcergo.com/', holds: ['Policy and e-card', 'Claims'] },
  { id: 'niva-bupa', name: 'Niva Bupa', category: 'insurance', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['nivabupa.com'], startUrl: 'https://www.nivabupa.com/', holds: ['Policy and e-card', 'Claims', 'Health check-ups'] },
  { id: 'care-insurance', name: 'Care Health Insurance', category: 'insurance', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['careinsurance.com'], startUrl: 'https://www.careinsurance.com/', holds: ['Policy and e-card', 'Claims'] },
  { id: 'icici-lombard', name: 'ICICI Lombard', category: 'insurance', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['icicilombard.com'], startUrl: 'https://www.icicilombard.com/', holds: ['Policy and e-card', 'Claims'] },
  { id: 'medi-assist', name: 'Medi Assist (TPA)', category: 'insurance', regions: IN, access: 'browser', signIn: 'otp',
    hosts: ['mediassist.in'], startUrl: 'https://www.mediassist.in/', holds: ['Employer health cover e-card', 'Claims'] },
  { id: 'employer-benefits', name: 'Employer health benefits (Plum, Loop, Onsurity and others)', category: 'insurance', regions: IN, access: 'browser', signIn: 'otp',
    holds: ['Group policy and e-card', 'Claims', 'Annual health check-ups'], note: 'Give the agent your benefits portal’s address.' },

  /* ---------------- devices and wearables ---------------- */
  { id: 'apple-health', name: 'Apple Health', category: 'wearable', regions: ALL, access: 'app', signIn: 'none',
    holds: ['Blood pressure', 'Glucose', 'Weight', 'Heart rate'], note: 'In the iPhone app: Files, Import from Apple Health.' },
  { id: 'health-connect', name: 'Health Connect (Android)', category: 'wearable', regions: ALL, access: 'app', signIn: 'none',
    holds: ['Blood pressure', 'Glucose', 'Weight', 'Heart rate'], note: 'In the Android app: Files, Import from Health Connect.' },
  { id: 'ultrahuman', name: 'Ultrahuman (Ring and M1 glucose)', category: 'wearable', regions: ALL, access: 'api', signIn: 'oauth', holds: ['Sleep', 'Heart rate', 'Continuous glucose'] },
  { id: 'oura', name: 'Oura', category: 'wearable', regions: ALL, access: 'api', signIn: 'oauth', holds: ['Sleep', 'Heart rate', 'Temperature'] },
  { id: 'fitbit', name: 'Fitbit and Google Health', category: 'wearable', regions: ALL, access: 'api', signIn: 'oauth', holds: ['Steps', 'Sleep', 'Heart rate', 'Weight'] },
  { id: 'garmin', name: 'Garmin', category: 'wearable', regions: ALL, access: 'api', signIn: 'oauth', holds: ['Steps', 'Sleep', 'Heart rate'] },
  { id: 'withings', name: 'Withings', category: 'wearable', regions: ALL, access: 'api', signIn: 'oauth', holds: ['Weight', 'Blood pressure'] },
  { id: 'libre', name: 'FreeStyle Libre (LibreView)', category: 'wearable', regions: ALL, access: 'api', signIn: 'oauth', holds: ['Continuous glucose'] },

  /* ---------------- messages and email ---------------- */
  { id: 'whatsapp', name: 'WhatsApp', category: 'inbox', regions: ALL, access: 'app', signIn: 'none',
    holds: ['Reports labs and doctors sent you'], note: 'Link WhatsApp on Account, then forward reports to LotusPond.' },
  { id: 'gmail', name: 'Gmail', category: 'inbox', regions: ALL, access: 'api', signIn: 'oauth',
    holds: ['Report PDFs labs emailed you'], note: 'Needs Google’s review of LotusPond for reading email attachments.' },
  { id: 'outlook', name: 'Outlook', category: 'inbox', regions: ALL, access: 'api', signIn: 'oauth', holds: ['Report PDFs labs emailed you'] },
];

/** The simulated portal (development and tests only; the server adds it when it serves the demo portal). */
export const DEMO_SOURCE: SourceInfo = {
  id: DEMO_SOURCE_ID, name: 'Demo Lab portal (simulated)', category: 'lab', regions: ALL, access: 'browser', signIn: 'otp',
  holds: ['Simulated lab reports'], note: 'A pretend lab portal run by this server, to try the record agent. The code it asks for is shown here.',
};

/** Whether the record agent can fetch from a source right now, and how. */
export type SourceAvailability =
  /** A written recipe: the agent follows known steps for this portal. */
  | 'recipe'
  /** No recipe yet: the agent (Claude) finds its way around the portal with the person. Experimental. */
  | 'navigator'
  /** Not through the record agent: ABDM, an official API, or elsewhere in the app. */
  | 'unavailable';

export interface SourceView extends SourceInfo {
  availability: SourceAvailability;
  /** Sources without a fixed address ("another lab"): the person gives the portal's address. */
  needsUrl: boolean;
}

export interface SourcesInfo {
  /** The record agent is switched on for this server. */
  enabled: boolean;
  /** What the browser runs on, as shown to the person: "LotusPond's servers" or a hosted browser provider. */
  browser: string | null;
  noticeVersion: string;
  sources: SourceView[];
}

export const RECORD_AGENT_NOTICE_VERSION = '2026-11-11';

export type RecordConnectionStatus = 'active' | 'needs_sign_in' | 'paused';
export type RecordRunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
export const RECORD_QUESTION_KINDS = ['phone', 'otp', 'password', 'username', 'text'] as const;
export type RecordQuestionKind = (typeof RECORD_QUESTION_KINDS)[number];

/** What the agent needs from the person to carry on. The answer goes to the portal and is never stored. */
export interface RecordQuestion {
  kind: RecordQuestionKind;
  label: string;
  /** Extra help, e.g. "Sent to the number ending 3210". For the demo portal, the code itself. */
  hint?: string;
  /** Hide what is typed. */
  secret: boolean;
  askedAt: string;
  /** When the agent stops waiting. */
  expiresAt: string;
}

export interface RecordRunView {
  id: string;
  connectionId: string;
  status: RecordRunStatus;
  trigger: 'person' | 'schedule';
  /** What the agent is doing, in a few words. */
  step: string | null;
  question: RecordQuestion | null;
  /** Reports found on the portal, and how many were new and saved to the files. */
  found: number;
  saved: number;
  /** Documents saved by this run, for the review links. */
  documents: { id: string; fileName: string }[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface RecordConnectionView {
  id: string;
  sourceId: string;
  sourceName: string;
  profileId: string;
  status: RecordConnectionStatus;
  /** The portal address, for sources without a fixed one. */
  portalUrl: string | null;
  /** Masked identifier the portal knows the person by, e.g. "••••• •3210". */
  identifier: string | null;
  /** Whether the agent kept the portal's sign-in, so it can check again without asking. */
  signedIn: boolean;
  refreshDays: number | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  reportsSaved: number;
  createdAt: string;
  lastRun: RecordRunView | null;
}

export const REFRESH_CHOICES: { days: number | null; label: string }[] = [
  { days: 7, label: 'Every week' },
  { days: 30, label: 'Every month' },
  { days: 90, label: 'Every 3 months' },
  { days: null, label: 'Only when I ask' },
];

export function sourceById(id: string): SourceInfo | undefined {
  return id === DEMO_SOURCE_ID ? DEMO_SOURCE : SOURCES.find(s => s.id === id);
}

/** "••••• •3210" for a phone number, "a•••@example.com"-style for anything else; never the whole value. */
export function maskIdentifier(v: string): string {
  const digits = v.replace(/\D/g, '');
  if (digits.length >= 8 && digits.length === v.replace(/[\s+()-]/g, '').length) return `••••• •${digits.slice(-4)}`;
  if (v.length <= 3) return '•••';
  return `${v.slice(0, 1)}•••${v.slice(-Math.min(4, Math.floor(v.length / 3)))}`;
}
