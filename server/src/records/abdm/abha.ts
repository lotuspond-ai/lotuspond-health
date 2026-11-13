// ABHA through Eka Care's ABDM Connect (docs/abdm.md): the record agent's way to the records hospitals and labs have
// linked to a person's ABHA, with no browser. The run asks the person what a portal would (an OTP, a PIN) through
// the same questions, and hands back FHIR bundles that are saved and reviewed like any fetched report.
//
//   1. Sign in: ABHA address (name@abdm), 14-digit ABHA number or mobile number → OTP → (choose an address when the
//      mobile has several) → Eka's id for the person (oid). Kept sealed as the connection's sign-in, with the address.
//   2. Gateway session: Eka holds the person's ABHA session with ABDM. Checked first; when it has ended (or a call
//      answers 491) one more OTP renews it. A scheduled run never asks: the connection then waits for the person.
//   3. Records: the facilities with records linked to the ABHA, and each one's records (care contexts) with their
//      state. Records with no consent yet get one consent request from LotusPond ("Self Requested", every record
//      type), which the person approves here with their ABHA consent PIN (never stored). Eka then fetches the data.
//   4. Each record Eka holds is read as a FHIR bundle (NRCES profiles) and saved once.
//
// Written from Eka's ABDM Connect reference (November 2026) and tested against a copy of it (test/abha.test.ts);
// the client login was checked live, the ABHA steps were not (they need a real ABHA and LotusPond's HIU onboarding).
import type { ApiContext, ApiFetcher } from '../api/types.ts';
import { PortalError, RunStoppedError, type PortalReport } from '../recipes/types.ts';
import { EkaError, EkaSessionError, type Eka } from './eka.ts';
import { ekaRef } from './webhook.ts';

/** What the connection keeps (sealed) between runs. */
export interface AbhaSession { oid: string; abhaAddress: string }

export type { ApiContext, ApiFetcher } from '../api/types.ts';

/** LotusPond as the health information user (HIU) its consent requests come from: Eka's clinic and doctor ids. */
export interface AbhaHiu { clinicId: string; doctorOid: string }

export interface AbhaOptions {
  eka: Eka;
  /** Without it LotusPond cannot raise consents, and only records already fetched to Eka are read. */
  hiu?: AbhaHiu;
  /** How long a run waits for Eka to fetch newly consented records, and how often it looks. */
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
}

/** Every kind of record ABDM carries (Eka's record_types). */
export const ABDM_RECORD_TYPES = ['DiagnosticReport', 'Prescription', 'OPConsultation', 'DischargeSummary', 'ImmunizationRecord', 'HealthDocumentRecord', 'WellnessRecord', 'Invoice'] as const;

/** Care context states (Eka's enum): the data is with Eka and can be read. */
const READY = new Set(['DataReceived', 'DataProcessed']);
/** On its way: a consent is waiting for the person, or Eka is fetching. */
const UNDER_WAY = new Set(['ConsentRaised', 'ConsentGranted', 'DataRequested', 'DataProcessing']);

type Method = 'phr_address' | 'abha_number' | 'mobile';

/** How LotusPond signs in with what the person typed: an address, an ABHA number or a mobile number. */
export function abhaLoginMethod(raw: string): { method: Method; identifier: string } | null {
  const t = raw.trim();
  if (/^[a-z0-9._-]{3,}@[a-z]{2,10}$/i.test(t)) return { method: 'phr_address', identifier: t.toLowerCase() };
  if (/^[a-z0-9._-]{4,32}$/i.test(t) && /[a-z]/i.test(t)) return { method: 'phr_address', identifier: `${t.toLowerCase()}@abdm` };
  const digits = t.replace(/[\s-]/g, '').replace(/^\+?91(?=\d{10}$)/, '');
  if (/^\d{14}$/.test(digits)) return { method: 'abha_number', identifier: `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}-${digits.slice(10)}` };
  if (/^[6-9]\d{9}$/.test(digits)) return { method: 'mobile', identifier: digits };
  return null;
}

/** What to tell the person when ABDM refuses. */
function explain(e: unknown): Error {
  if (!(e instanceof EkaError)) return e as Error;
  if (e.code === 'ABDM-1100') return new PortalError('Too many OTP requests or attempts. ABDM asks you to wait 30 minutes, then try again.');
  if (e.code === 'ABDM-1027') return new PortalError('ABDM has blocked sign-in for this ABHA for 24 hours after repeated attempts.');
  if (e.code === 'ABDM-1022' || e.status === 429) return new PortalError('ABDM is busy. Try again in a few minutes.');
  if (e.status >= 500) return new PortalError('ABDM or Eka Care is not answering right now. Try again later.');
  return new PortalError(`ABHA: ${e.message.slice(0, 160)}`);
}

export function abhaFetcher(o: AbhaOptions): ApiFetcher {
  const { eka } = o;
  const waitMs = o.waitMs ?? 2 * 60_000;
  const pollMs = o.pollMs ?? 5000;
  const now = o.now ?? Date.now;

  /** Ask for an OTP and pass it to `verify`; a refused code is asked once more. */
  async function withOtp<T>(ctx: ApiContext, label: string, verify: (otp: string) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const otp = (await ctx.ask({ kind: 'otp', label: attempt ? 'That OTP was not accepted. Enter the OTP again (or the new one)' : label })).replace(/\s+/g, '');
      try {
        return await verify(otp);
      } catch (e) {
        if (e instanceof EkaError && e.status < 500 && e.code !== 'ABDM-1100' && e.code !== 'ABDM-1027' && attempt === 0) continue;
        throw explain(e);
      }
    }
  }

  async function signIn(ctx: ApiContext): Promise<AbhaSession> {
    await ctx.step('Signing in with your ABHA');
    const raw = ctx.identifier ?? await ctx.ask({
      kind: 'text', label: 'Your ABHA address, ABHA number or mobile number',
      hint: 'For example name@abdm, the 14-digit ABHA number, or the mobile number on your ABHA',
    });
    const login = abhaLoginMethod(raw);
    if (!login) throw new PortalError('That is not an ABHA address (name@abdm), a 14-digit ABHA number or a 10-digit mobile number.');
    const init = await eka.call<{ txn_id: string; hint?: string }>('/abdm/na/v1/profile/login/init', { body: { method: login.method, identifier: login.identifier } }).catch(e => { throw explain(e); });
    const sentTo = init.hint ? ` (${init.hint.slice(0, 80)})` : '';
    type Verified = { txn_id?: string; skip_state?: string; eka?: { oid?: string | null }; profile?: { abha_address?: string }; abha_profiles?: { abha_address: string; name?: string }[] };
    const v = await withOtp(ctx, `OTP ABDM sent for your ABHA${sentTo}`, otp => eka.call<Verified>('/abdm/na/v1/profile/login/verify', { body: { txn_id: init.txn_id, otp } }));
    let oid = v.eka?.oid ?? null;
    let address = v.profile?.abha_address ?? null;
    if (v.skip_state === 'abha_create' || (v.skip_state !== 'abha_end' && !v.abha_profiles?.length)) {
      throw new PortalError('There is no ABHA for that number yet. Create one in the ABHA app (or at abha.abdm.gov.in), then connect it here.');
    }
    if (v.skip_state !== 'abha_end') {
      // A mobile number with one or more ABHA addresses: the person picks one (or the only one is used).
      const choices = v.abha_profiles!.map(p => p.abha_address);
      let chosen = choices.length === 1 ? choices[0] : null;
      while (!chosen) {
        const a = (await ctx.ask({ kind: 'text', label: 'Which ABHA address should LotusPond use?', hint: choices.map((c, i) => `${i + 1}. ${c}`).join('  ').slice(0, 160) })).trim().toLowerCase();
        chosen = choices.find((c, i) => c.toLowerCase() === a || String(i + 1) === a || c.toLowerCase().split('@')[0] === a) ?? null;
      }
      const r = await eka.call<Verified>('/abdm/na/v1/profile/login/phr', { body: { txn_id: v.txn_id ?? init.txn_id, phr_address: chosen } }).catch(e => { throw explain(e); });
      oid = r.eka?.oid ?? oid;
      address = r.profile?.abha_address ?? chosen;
    }
    if (!oid || !address) throw new PortalError('ABDM signed you in but did not say which ABHA. Try again.');
    return { oid, abhaAddress: address };
  }

  /** Make sure Eka holds a live ABHA gateway session for the person; renew it with an OTP when it has ended. */
  async function ensureSession(ctx: ApiContext, s: AbhaSession, known = false): Promise<void> {
    if (!known) {
      const st = await eka.call<{ logged_in?: boolean }>('/abdm/v1/session/status', { oid: s.oid }).catch(e => { if (e instanceof EkaSessionError) return { logged_in: false }; throw explain(e); });
      if (st.logged_in) return;
    }
    await ctx.step('Renewing your ABHA session');
    const init = await eka.call<{ txn_id: string }>('/abdm/v1/session/init', { oid: s.oid, body: { abha_address: s.abhaAddress } }).catch(e => { throw explain(e); });
    await withOtp(ctx, 'OTP ABDM sent to the mobile number on your ABHA', otp => eka.call('/abdm/v1/session/verify', { oid: s.oid, body: { txn_id: init.txn_id, otp } }));
  }

  interface Linked { hipId: string; hipName: string; id: string; display: string; createdAt: string | null; status: string | null }

  async function linkedRecords(s: AbhaSession): Promise<Linked[]> {
    const p = await eka.call<{ providers?: { hip_id: string; hip_name?: string }[] | null }>('/abdm/v1/care-contexts/providers', { oid: s.oid });
    const out: Linked[] = [];
    for (const hip of p.providers ?? []) {
      const r = await eka.call<{ care_contexts?: { care_context_id: string; display?: string; created_at?: string; status?: string }[] | null }>('/abdm/v1/care-contexts/linked', { oid: s.oid, query: { hip_id: hip.hip_id } });
      for (const c of r.care_contexts ?? []) {
        out.push({ hipId: hip.hip_id, hipName: hip.hip_name?.trim() || hip.hip_id, id: c.care_context_id, display: c.display?.trim() || 'Health record', createdAt: c.created_at ?? null, status: c.status ?? null });
      }
    }
    return out;
  }

  /**
   * One consent request from LotusPond for every record type, then the person approves it here with their consent
   * PIN. Returns false when it could not be approved here (no PIN set, or the request did not reach the inbox):
   * the person can still approve it in their ABHA app, and the next check picks the records up.
   */
  async function requestConsent(ctx: ApiContext, s: AbhaSession, hiu: AbhaHiu, hips: string[]): Promise<boolean> {
    await ctx.step('Asking ABDM for your consent to fetch the records');
    // The person's inbox can hold requests from other health information users too. Approving one of those with the
    // PIN the person gives for LotusPond would share their records with someone else, so LotusPond approves only a
    // request it can tell is its own; otherwise the person approves it in their ABHA app, which shows who asks.
    type Req = { id: string; created_at?: string; consent_init_id?: string; consent_request_id?: string; request_id?: string };
    const inbox = async () => (await eka.call<{ consents?: Req[] | null }>('/abdm/v1/requests', { oid: s.oid, query: { status: 'requested', type: 'consent' } })).consents ?? [];
    const earlier = new Set((await inbox()).map(r => r.id));
    const at = now();
    const year = 365 * 24 * 60 * 60_000;
    const created = await eka.call<{ consent_init_id?: string; consent_request_id?: string; id?: string } | null>('/abdm/v1/consents/create', {
      oid: s.oid,
      body: {
        patient: { health_id: s.abhaAddress, oid: s.oid },
        hiu: { clinic_id: hiu.clinicId, d_oid: hiu.doctorOid },
        purpose: 'Self Requested',
        record_types: ABDM_RECORD_TYPES,
        period: { from: '1990-01-01T00:00:00Z', to: new Date(at).toISOString(), expiry: new Date(at + year).toISOString() },
      },
    });
    // The request lands in the person's own consent inbox. A candidate: the one new request that carries the id the
    // create call returned, or else the only request that arrived since the inbox was read just before.
    const ours = new Set([created?.consent_init_id, created?.consent_request_id, created?.id].filter((x): x is string => !!x));
    const fresh = (await inbox()).filter(r => !earlier.has(r.id) && (!r.created_at || Date.parse(r.created_at) >= at - 5 * 60_000));
    const tagged = fresh.filter(r => [r.consent_init_id, r.consent_request_id, r.request_id].some(x => !!x && ours.has(x)));
    const mine = tagged.length === 1 ? tagged[0] : !tagged.length && fresh.length === 1 ? fresh[0] : undefined;
    if (!mine) return false;
    const byId = tagged.length === 1;
    const pin = await eka.call<{ exist?: boolean }>('/abdm/v1/consents/pin/exists', { oid: s.oid });
    if (pin.exist === false) return false;
    type Detail = {
      hi_types?: string[]; duration?: { from: string; to: string }; erase_at?: string; providers?: { hip: { id: string; name?: string }; care_contexts?: { id: string; display?: string }[] }[];
      purpose?: string | { text?: string; code?: string }; hiu?: { clinic_id?: string; id?: string };
    };
    const d = await eka.call<Detail>('/abdm/v1/request', { oid: s.oid, query: { id: mine.id, type: 'consent', status: 'requested' } });
    // It must be LotusPond's: Self Requested (ABDM code PATRQT), from LotusPond's clinic at Eka. A request tied to the
    // create call by its id only has to not say otherwise; one found only by arriving alone must say so itself. A
    // request that does not show both is left to the person's ABHA app, which shows who asks: never approved here.
    const purpose = typeof d.purpose === 'string' ? d.purpose : d.purpose?.text ?? d.purpose?.code;
    const clinic = d.hiu?.clinic_id ?? d.hiu?.id;
    const purposeOk = purpose ? /self|PATRQT/i.test(purpose) : byId;
    const clinicOk = clinic ? clinic === hiu.clinicId : byId;
    if (!purposeOk || !clinicOk) return false;
    const providers: NonNullable<Detail['providers']> = d.providers?.length ? d.providers : hips.map(id => ({ hip: { id }, care_contexts: [] }));
    const names = [...new Set(providers.map(p => p.hip.name ?? p.hip.id))];
    for (let attempt = 0; ; attempt++) {
      const answer = (await ctx.ask({
        kind: 'password', secret: true,
        label: attempt ? 'That PIN was not accepted. Enter your ABHA consent PIN again' : 'Your ABHA consent PIN, to let LotusPond fetch these records',
        hint: `From ${names.join(', ')}`.slice(0, 160),
      })).trim();
      try {
        await eka.call('/abdm/v1/consents/pin/verify', { oid: s.oid, body: { pin: answer } });
        break;
      } catch (e) {
        if (e instanceof EkaError && e.status < 500 && attempt === 0) continue;
        throw explain(e);
      }
    }
    await eka.call('/abdm/v1/consents/approve', {
      oid: s.oid,
      body: {
        id: mine.id,
        consent_artefacts: providers.map(p => ({
          hip_id: p.hip.id, care_contexts: p.care_contexts ?? [], hi_types: d.hi_types ?? [...ABDM_RECORD_TYPES], access_mode: 'view',
          ...(d.duration ? { duration: d.duration } : {}), ...(d.erase_at ? { erase_at: d.erase_at } : {}),
        })),
      },
    });
    return true;
  }

  async function wait(ms: number, signal: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new RunStoppedError('Cancelled.')); }, { once: true });
    });
  }

  async function readRecord(s: AbhaSession, r: Linked, maxBytes: number): Promise<PortalReport | null> {
    let bundle: { resourceType?: string; entry?: unknown[] };
    try {
      bundle = await eka.call('/health/api/v1/fhir/retrieve', { oid: s.oid, query: { identifier: r.id } });
    } catch (e) {
      if (e instanceof EkaError && e.status === 404) return null;
      throw e;
    }
    if (bundle.resourceType !== 'Bundle' || !bundle.entry?.length) return null;
    const bytes = new Uint8Array(Buffer.from(JSON.stringify(bundle), 'utf8'));
    if (bytes.byteLength > maxBytes) return null;
    const title = `${r.hipName}: ${r.display}`.slice(0, 160);
    return { key: `${r.hipId}\u0000${r.id}`, title, date: r.createdAt && /^\d{4}-\d{2}-\d{2}/.test(r.createdAt) ? r.createdAt.slice(0, 10) : null, fileName: `${r.hipName} ${r.display}`, contentType: 'application/fhir+json', bytes };
  }

  return {
    sourceId: 'abha',
    async run(ctx) {
      let s: AbhaSession | null = null;
      try { const p = ctx.session ? JSON.parse(ctx.session) as AbhaSession : null; if (p?.oid && p.abhaAddress) s = p; } catch { s = null; }
      if (!s) {
        s = await signIn(ctx);
        ctx.keep(JSON.stringify(s), ekaRef(s.oid));
        ctx.remember(s.abhaAddress);
      }
      const session = s;
      await ensureSession(ctx, session);
      // A call that finds the session ended (491) renews it once and tries again.
      const live = async <T>(fn: () => Promise<T>): Promise<T> => {
        try { return await fn(); } catch (e) {
          if (!(e instanceof EkaSessionError)) throw explain(e);
          await ensureSession(ctx, session, true);
          return fn().catch(err => { throw explain(err); });
        }
      };

      await ctx.step('Reading the records linked to your ABHA');
      let records = await live(() => linkedRecords(session));
      const unasked = records.filter(r => !r.status);
      if (unasked.length) {
        if (!o.hiu) {
          console.warn('[records] ABHA: records need a consent, but EKA_HIU_CLINIC_ID / EKA_HIU_DOCTOR_OID are not set');
        } else {
          const approved = await live(() => requestConsent(ctx, session, o.hiu!, [...new Set(unasked.map(r => r.hipId))]));
          if (approved) {
            await ctx.step('Waiting for ABDM to send the records');
            const until = now() + waitMs;
            while (now() < until) {
              await wait(pollMs, ctx.signal);
              records = await live(() => linkedRecords(session));
              if (!records.some(r => !r.status || UNDER_WAY.has(r.status))) break;
            }
          } else {
            ctx.note('LotusPond asked for your consent. Approve the request in your ABHA app; the records come in on the next check.');
          }
        }
      }

      const ready = records.filter(r => r.status && READY.has(r.status));
      if (!ready.length) {
        if (!records.length) throw new PortalError('No hospital or lab has linked records to this ABHA yet. When one does, LotusPond can fetch them.');
        if (records.some(r => r.status && UNDER_WAY.has(r.status))) ctx.note('ABDM is still sending your records. LotusPond checks again when they arrive.');
        return [];
      }
      await ctx.step(`Reading ${ready.length} record${ready.length === 1 ? '' : 's'}`);
      const out: PortalReport[] = [];
      for (const r of ready) {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new RunStoppedError('Cancelled.');
        const report = await live(() => readRecord(session, r, ctx.maxBytes));
        if (report) out.push(report);
      }
      return out;
    },
  };
}
