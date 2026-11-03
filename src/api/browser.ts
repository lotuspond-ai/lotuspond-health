// Backend that keeps accounts, profiles, records and files in this browser's IndexedDB.
// Used by preview builds that have no server (for example the hosted artifact). It follows the API's rules,
// but nothing leaves the device and nothing is shared between browsers.
import { createStore, del, delMany, get, keys, set, type UseStore } from 'idb-keyval';
import type {
  Account, DocumentKind, Measurement, MeasurementInput, Profile, ProfileInput, ProfileRecords, ScanInput, ScanItem, SessionInfo, StoredDocument,
  FacilitySearchResult, GeoCandidate, GeoReverse, PublicConfig,
} from '../types';
import { LIMITS } from '../../shared/constants';
import { isLatitude, isLongitude, roundCoord } from '../../shared/facilities';
import { isCountryCode } from '../../shared/regions';
import { searchOffline } from './gazetteer';
import { uid } from '../lib/id';
import { ApiError, type Backend, type ScanPatch } from './backend';

interface StoredAccount extends Account { salt: string; hash: string }

const ACCOUNTS = 'accounts';
const SESSION = 'session';
const profilesKey = (accountId: string) => `profiles:${accountId}`;
const recordsKey = (profileId: string) => `records:${profileId}`;
const fileKey = (docId: string) => `file:${docId}`;
const RANK: Record<string, number> = { self: 0, partner: 1, child: 2, parent: 3, sibling: 4, other: 5 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const now = () => new Date().toISOString();
const bad = (message: string, code = 'invalid') => new ApiError(400, code, message);
const missing = (what: string) => new ApiError(404, 'not_found', `${what} was not found.`);

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function derive(password: string, saltHex: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new ApiError(500, 'unsupported', 'This browser cannot create accounts here. Use a recent version of Chrome, Edge, Firefox or Safari.');
  const salt = new Uint8Array(saltHex.match(/../g)!.map(h => parseInt(h, 16)));
  const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return toHex(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 210_000 }, key, 256));
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b.buffer);
}

function validDate(s: unknown): boolean {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

function cleanList(list: unknown): string[] | undefined {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw bad('Lists must be lists of text.');
  return [...new Set(list.map(x => String(x).trim()).filter(Boolean).map(x => x.slice(0, LIMITS.listItemLength)))].slice(0, LIMITS.listItems);
}

/** Apply the same checks the API makes on profile fields. */
function checkProfile(patch: Partial<ProfileInput>): Partial<ProfileInput> {
  const out: Partial<ProfileInput> = { ...patch };
  if (patch.displayName !== undefined) {
    out.displayName = patch.displayName.trim().slice(0, 80);
    if (!out.displayName) throw bad('displayName: Enter a name.');
  }
  if (patch.dateOfBirth) {
    if (!validDate(patch.dateOfBirth)) throw bad('dateOfBirth: Use a date in the form yyyy-mm-dd.');
    if (patch.dateOfBirth > now().slice(0, 10)) throw bad('dateOfBirth: Date of birth cannot be in the future.');
  }
  if (patch.heightCm != null && (patch.heightCm < 20 || patch.heightCm > 272)) throw bad('heightCm: Height looks out of range.');
  if (patch.weightKg != null && (patch.weightKg < 0.5 || patch.weightKg > 650)) throw bad('weightKg: Weight looks out of range.');
  for (const k of ['conditions', 'medications', 'allergies'] as const) {
    const v = cleanList(patch[k]);
    if (v) out[k] = v;
  }
  if (patch.notes !== undefined) out.notes = patch.notes.slice(0, LIMITS.notesLength);
  return checkLocation(patch, out);
}

/** Home area, with the API's rules: coordinates rounded to about 1 km, set or cleared together. */
function checkLocation(patch: Partial<ProfileInput>, out: Partial<ProfileInput>): Partial<ProfileInput> {
  if (patch.latitude !== undefined || patch.longitude !== undefined) {
    if (patch.latitude === undefined || patch.longitude === undefined || (patch.latitude === null) !== (patch.longitude === null)) {
      throw bad('latitude: Send latitude and longitude together.');
    }
    if (patch.latitude !== null && patch.longitude !== null) {
      if (!isLatitude(patch.latitude)) throw bad('latitude: Latitude must be between -90 and 90.');
      if (!isLongitude(patch.longitude)) throw bad('longitude: Longitude must be between -180 and 180.');
      out.latitude = roundCoord(patch.latitude);
      out.longitude = roundCoord(patch.longitude);
    }
  }
  if (patch.country) {
    if (!isCountryCode(patch.country)) throw bad('country: Choose a country.');
    out.country = patch.country.trim().toUpperCase();
  }
  if (patch.locality !== undefined) out.locality = patch.locality?.trim().slice(0, 120) || null;
  if (patch.postalCode !== undefined) out.postalCode = patch.postalCode?.trim().slice(0, 20) || null;
  return out;
}

export class BrowserBackend implements Backend {
  readonly kind = 'browser' as const;
  private readonly dbName: string;
  private db: UseStore | null = null;
  /** Serialises writes so concurrent saves cannot overwrite each other. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dbName = 'lotuspond-preview') {
    this.dbName = dbName;
  }

  /** Opened on first use: where site storage is blocked, opening throws, and that should fail a request, not the page. */
  private get store(): UseStore {
    if (!this.db) {
      try {
        this.db = createStore(this.dbName, 'kv');
      } catch {
        throw new ApiError(503, 'storage_blocked', 'This browser is blocking site storage, so the preview cannot keep an account. Allow site data for this page, or open it outside a private window.');
      }
    }
    return this.db;
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async accounts(): Promise<StoredAccount[]> {
    return (await get<StoredAccount[]>(ACCOUNTS, this.store)) ?? [];
  }

  private async current(): Promise<StoredAccount> {
    const id = await get<string>(SESSION, this.store);
    const acc = id ? (await this.accounts()).find(a => a.id === id) : undefined;
    if (!acc) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    return acc;
  }

  private async profiles(accountId: string): Promise<Profile[]> {
    const list = (await get<Profile[]>(profilesKey(accountId), this.store)) ?? [];
    return list.sort((a, b) => (RANK[a.relationship] ?? 9) - (RANK[b.relationship] ?? 9) || a.createdAt.localeCompare(b.createdAt));
  }

  /** The profile, checked to belong to the signed-in account. */
  private async owned(profileId: string): Promise<{ account: StoredAccount; profiles: Profile[]; profile: Profile }> {
    const account = await this.current();
    const profiles = await this.profiles(account.id);
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) throw missing('That profile');
    return { account, profiles, profile };
  }

  private async readRecords(profileId: string): Promise<ProfileRecords> {
    return (await get<ProfileRecords>(recordsKey(profileId), this.store)) ?? { measurements: [], scans: [], documents: [] };
  }

  private async session(account: StoredAccount): Promise<SessionInfo> {
    return { account: { id: account.id, email: account.email, createdAt: account.createdAt }, profiles: await this.profiles(account.id) };
  }

  private async removeProfileData(profileId: string): Promise<void> {
    const rec = await this.readRecords(profileId);
    await delMany([recordsKey(profileId), ...rec.documents.map(d => fileKey(d.id))], this.store);
  }

  /* ---------------- accounts ---------------- */

  async me(): Promise<SessionInfo | null> {
    try {
      return await this.session(await this.current());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  }

  register(input: { email: string; password: string; displayName: string }): Promise<SessionInfo> {
    return this.locked(async () => {
      const email = input.email.trim().toLowerCase();
      const displayName = input.displayName.trim();
      if (!displayName) throw bad('displayName: Enter your name.');
      if (!EMAIL.test(email) || email.length > 254) throw bad('email: Enter a valid email address.');
      if (input.password.length < LIMITS.passwordMin) throw bad(`password: Use at least ${LIMITS.passwordMin} characters.`);
      if (input.password.length > LIMITS.passwordMax) throw bad(`password: Use at most ${LIMITS.passwordMax} characters.`);
      const accounts = await this.accounts();
      if (accounts.some(a => a.email === email)) throw new ApiError(409, 'email_taken', 'An account with this email already exists. Sign in instead.');
      const salt = randomHex(16);
      const account: StoredAccount = { id: uid(), email, createdAt: now(), salt, hash: await derive(input.password, salt) };
      const self: Profile = {
        id: uid(), relationship: 'self', displayName: displayName.slice(0, 80), dateOfBirth: null, sex: null, heightCm: null, weightKg: null,
        bloodType: null, conditions: [], medications: [], allergies: [], notes: '', createdAt: now(), updatedAt: now(),
      };
      await set(ACCOUNTS, [...accounts, account], this.store);
      await set(profilesKey(account.id), [self], this.store);
      await set(SESSION, account.id, this.store);
      return this.session(account);
    });
  }

  async login(input: { email: string; password: string }): Promise<SessionInfo> {
    const email = input.email.trim().toLowerCase();
    const account = (await this.accounts()).find(a => a.email === email);
    const hash = await derive(input.password, account?.salt ?? '00'.repeat(16));
    if (!account || hash !== account.hash) throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect.');
    await set(SESSION, account.id, this.store);
    return this.session(account);
  }

  async logout(): Promise<void> {
    await del(SESSION, this.store);
  }

  changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return this.locked(async () => {
      const account = await this.current();
      if ((await derive(currentPassword, account.salt)) !== account.hash) throw bad('Your current password is incorrect.', 'wrong_password');
      if (newPassword.length < LIMITS.passwordMin) throw bad(`newPassword: Use at least ${LIMITS.passwordMin} characters.`);
      const salt = randomHex(16);
      const updated = { ...account, salt, hash: await derive(newPassword, salt) };
      await set(ACCOUNTS, (await this.accounts()).map(a => (a.id === account.id ? updated : a)), this.store);
    });
  }

  async signOutOtherSessions(): Promise<void> {
    await this.current(); // a browser holds a single session
  }

  deleteAccount(password: string): Promise<void> {
    return this.locked(async () => {
      const account = await this.current();
      if ((await derive(password, account.salt)) !== account.hash) throw bad('Your password is incorrect.', 'wrong_password');
      for (const p of await this.profiles(account.id)) await this.removeProfileData(p.id);
      await del(profilesKey(account.id), this.store);
      await set(ACCOUNTS, (await this.accounts()).filter(a => a.id !== account.id), this.store);
      await del(SESSION, this.store);
    });
  }

  /* ---------------- profiles ---------------- */

  createProfile(input: ProfileInput): Promise<Profile> {
    return this.locked(async () => {
      const account = await this.current();
      const list = await this.profiles(account.id);
      if (list.length >= LIMITS.profilesPerAccount) throw new ApiError(409, 'conflict', `An account can hold up to ${LIMITS.profilesPerAccount} profiles.`);
      if (input.relationship === 'self') throw bad('Your account already has your own profile. Choose who this person is to you.');
      const fields = checkProfile(input);
      const profile: Profile = {
        id: uid(), relationship: 'other', dateOfBirth: null, sex: null, heightCm: null, weightKg: null, bloodType: null,
        conditions: [], medications: [], allergies: [], notes: '', ...fields, displayName: fields.displayName ?? input.displayName,
        createdAt: now(), updatedAt: now(),
      };
      await set(profilesKey(account.id), [...list, profile], this.store);
      return profile;
    });
  }

  updateProfile(id: string, patch: Partial<ProfileInput>): Promise<Profile> {
    return this.locked(async () => {
      const { account, profiles, profile } = await this.owned(id);
      if (patch.relationship && (patch.relationship === 'self') !== (profile.relationship === 'self')) {
        throw bad(profile.relationship === 'self' ? 'Your own profile stays marked as you.' : 'Only your own profile can be marked as you.');
      }
      const updated: Profile = { ...profile, ...checkProfile(patch), updatedAt: now() };
      await set(profilesKey(account.id), profiles.map(p => (p.id === id ? updated : p)), this.store);
      return updated;
    });
  }

  deleteProfile(id: string): Promise<void> {
    return this.locked(async () => {
      const { account, profiles, profile } = await this.owned(id);
      if (profile.relationship === 'self') throw new ApiError(409, 'conflict', 'Your own profile cannot be removed. To remove everything, delete your account.');
      await this.removeProfileData(id);
      await set(profilesKey(account.id), profiles.filter(p => p.id !== id), this.store);
    });
  }

  /* ---------------- records ---------------- */

  async records(profileId: string): Promise<ProfileRecords> {
    await this.owned(profileId);
    return this.readRecords(profileId);
  }

  private mutate<T>(profileId: string, fn: (rec: ProfileRecords) => T | Promise<T>): Promise<T> {
    return this.locked(async () => {
      await this.owned(profileId);
      const rec = await this.readRecords(profileId);
      const out = await fn(rec);
      await set(recordsKey(profileId), rec, this.store);
      return out;
    });
  }

  clearRecords(profileId: string): Promise<void> {
    return this.locked(async () => {
      await this.owned(profileId);
      await this.removeProfileData(profileId);
    });
  }

  addMeasurements(profileId: string, rows: MeasurementInput[]): Promise<Measurement[]> {
    return this.mutate(profileId, rec => {
      if (!rows.length || rows.length > LIMITS.measurementsPerRequest) throw bad('measurements: Send between 1 and 2000 results.');
      const docs = new Set(rec.documents.map(d => d.id));
      if (rows.some(r => r.documentId && !docs.has(r.documentId))) throw bad('A linked document does not belong to this profile.');
      const created = rows.map(r => ({ ...r, documentId: r.documentId ?? null, id: uid() }));
      rec.measurements.push(...created);
      return created;
    });
  }

  updateMeasurement(profileId: string, id: string, patch: Partial<MeasurementInput>): Promise<Measurement> {
    return this.mutate(profileId, rec => {
      const i = rec.measurements.findIndex(m => m.id === id);
      if (i < 0) throw missing('That result');
      rec.measurements[i] = { ...rec.measurements[i], ...patch, id };
      return rec.measurements[i];
    });
  }

  deleteMeasurement(profileId: string, id: string): Promise<void> {
    return this.mutate(profileId, rec => {
      const before = rec.measurements.length;
      rec.measurements = rec.measurements.filter(m => m.id !== id);
      if (rec.measurements.length === before) throw missing('That result');
    });
  }

  uploadDocument(profileId: string, file: Blob, fileName: string, kind: DocumentKind): Promise<StoredDocument> {
    return this.mutate(profileId, async rec => {
      if (!file.size) throw bad('This file is empty.');
      const doc: StoredDocument = {
        id: uid(), fileName: fileName.split(/[\\/]/).pop()?.slice(0, 200) || 'file', contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size, kind, createdAt: now(),
      };
      await set(fileKey(doc.id), file, this.store);
      rec.documents.unshift(doc);
      return doc;
    });
  }

  async documentFile(profileId: string, id: string): Promise<Blob> {
    const rec = await this.records(profileId);
    if (!rec.documents.some(d => d.id === id)) throw missing('That file');
    const blob = await get<Blob>(fileKey(id), this.store);
    if (!(blob instanceof Blob)) throw missing('The original file');
    return blob;
  }

  deleteDocument(profileId: string, id: string): Promise<void> {
    return this.mutate(profileId, async rec => {
      if (!rec.documents.some(d => d.id === id)) throw missing('That file');
      rec.documents = rec.documents.filter(d => d.id !== id);
      rec.scans = rec.scans.filter(s => s.blobKey !== id);
      rec.measurements = rec.measurements.map(m => (m.documentId === id ? { ...m, documentId: null } : m));
      await del(fileKey(id), this.store);
    });
  }

  documentUrl(): string | null { return null; }
  exportUrl(): string | null { return null; }

  addScans(profileId: string, scans: ScanInput[]): Promise<ScanItem[]> {
    return this.mutate(profileId, rec => {
      const docs = new Set(rec.documents.map(d => d.id));
      if (scans.some(s => !docs.has(s.blobKey))) throw bad('A linked document does not belong to this profile.');
      const created = scans.map(s => ({ ...s, id: uid() }));
      rec.scans.push(...created);
      return created;
    });
  }

  updateScan(profileId: string, id: string, patch: ScanPatch): Promise<ScanItem> {
    return this.mutate(profileId, rec => {
      const i = rec.scans.findIndex(s => s.id === id);
      if (i < 0) throw missing('That scan');
      rec.scans[i] = { ...rec.scans[i], ...patch, id, blobKey: rec.scans[i].blobKey };
      return rec.scans[i];
    });
  }

  deleteScan(profileId: string, id: string): Promise<void> {
    return this.mutate(profileId, async rec => {
      const scan = rec.scans.find(s => s.id === id);
      if (!scan) throw missing('That scan');
      rec.scans = rec.scans.filter(s => s.id !== id);
      rec.documents = rec.documents.filter(d => d.id !== scan.blobKey);
      await del(fileKey(scan.blobKey), this.store);
    });
  }

  /* ---------------- nearby labs (needs the server) ---------------- */

  async publicConfig(): Promise<PublicConfig> {
    return { map: null, nearbySearch: false };
  }

  async nearbyFacilities(): Promise<FacilitySearchResult> {
    throw new ApiError(503, 'preview', 'Finding labs needs the LotusPond server, and this preview runs without one.');
  }

  /** A short offline list of cities, so an area can still be chosen and saved. */
  async searchPlaces(q: string): Promise<GeoCandidate[]> {
    return searchOffline(q);
  }

  async reversePlace(lat: number, lon: number): Promise<GeoReverse> {
    const la = roundCoord(lat), lo = roundCoord(lon);
    return { label: `${Math.abs(la).toFixed(2)}° ${la >= 0 ? 'N' : 'S'}, ${Math.abs(lo).toFixed(2)}° ${lo >= 0 ? 'E' : 'W'}`, country: null, postalCode: null };
  }

  /** Every key this backend holds (used by tests and for diagnostics). */
  async allKeys(): Promise<IDBValidKey[]> {
    return keys(this.store);
  }
}
