// Backend that talks to the LotusPond API: on the same origin (/api) with cookie sessions on the website, or
// across sites with token sessions in the iOS and Android apps (see ./appSession.ts).
import { AI_EXTRACTION_NOTICE_VERSION, type AiExtraction } from '../../shared/types';
import type { NotificationList, UndoResult } from '../../shared/notifications';
import { ASSISTANT_NOTICE_VERSION, type AssistantConsent, type AssistantEvent, type AssistantInfo, type AssistantMessage } from '../../shared/assistant';
import { WHATSAPP_NOTICE_VERSION, type WhatsAppInfo, type WhatsAppLink, type WhatsAppLinkStart } from '../../shared/whatsapp';
import { RECORD_AGENT_NOTICE_VERSION, type RecordConnectionView, type RecordRunView, type SourcesInfo } from '../../shared/sources';
import type { AgentCategory } from '../../shared/agents';
import type { AgentConnection, AgentConnectionsInfo, CreateAgentTokenInput, CreatedAgentToken, UpdateAgentConnectionInput } from '../../shared/agents';
import type {
  Account, ActivityEvent, FamilyConfirmation, ConsentKind, ConsentRecord, DocumentKind, Measurement, MeasurementInput, Profile, ProfileInput, ProfileRecords,
  RegisterInput, ScanInput, ScanItem, ServiceInfo, SessionInfo, StoredDocument,
} from '../types';
import type { FacilityQuery, FacilitySearchResult, GeoCandidate, GeoReverse, PublicConfig } from '../types';
import { roundCoord } from '../../shared/facilities';
import { countryPolicy } from '../../shared/regions';
import { ApiError, type Backend, type ScanPatch } from './backend';
import type { AppSession, Region } from './appSession';
import type { LabBookingInput, LabCatalog, LabOrderView, LabResultSaved, LabResultView, LabSlot } from '../../shared/lab-bundle';

const BASE = '/api';

type AppSignIn = SessionInfo & { token?: string; expiresAt?: string };

export class HttpBackend implements Backend {
  readonly kind = 'server' as const;
  /** Called when a request fails because the session ended (for example, signed out on another device). */
  onSessionEnded: (() => void) | null = null;
  /** Token session of the iOS / Android apps; null on the website (cookie session on the same origin). */
  private readonly app: AppSession | null;
  /** Regional API hosts, from /auth/config, used to create an account in the right region. */
  private apiOrigins: Partial<Record<Region, string>> = {};

  constructor(options: { app?: AppSession } = {}) {
    this.app = options.app ?? null;
  }

  private base(): string {
    return this.app ? `${this.app.origin}${BASE}` : BASE;
  }

  private async init(method: string): Promise<RequestInit> {
    if (!this.app) return { method, credentials: 'same-origin', headers: {} };
    await this.app.ready;
    return { method, credentials: 'omit', headers: this.app.headers() };
  }

  private async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const init = await this.init(method);
    Object.assign(init.headers as Record<string, string>, headers);
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    }
    let res: Response;
    try {
      res = await fetch(this.base() + path, init);
    } catch {
      throw new ApiError(0, 'network', 'Could not reach the LotusPond server. Check your connection and try again.');
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } & Record<string, unknown> } | null)?.error;
      if (res.status === 401 && !path.startsWith('/auth/')) {
        if (this.app) await this.app.clear();
        this.onSessionEnded?.();
      }
      throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `The server answered ${res.status}. Try again.`, err ?? {});
    }
    return data as T;
  }

  async me() {
    if (this.app) {
      await this.app.ready;
      if (!this.app.signedIn) return null; // no token kept: signed out, without a round trip
    }
    try {
      const info = await this.request<SessionInfo | null>('GET', '/auth/me');
      if (!info && this.app) await this.app.clear();
      return info;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { if (this.app) await this.app.clear(); return null; }
      throw e;
    }
  }
  async service() {
    const info = await this.request<ServiceInfo>('GET', '/auth/config');
    this.apiOrigins = info.apiOrigins ?? {};
    return info;
  }
  async accountsPending() {
    try {
      return await this.request<{ email: string; region: string | null }>('GET', '/auth/accounts/pending');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }
  completeAccountsSignUp(input: Omit<RegisterInput, 'email' | 'password'>) {
    return this.request<SessionInfo>('POST', '/auth/accounts/complete', input);
  }
  register(input: RegisterInput) {
    if (!this.app) return this.request<SessionInfo>('POST', '/auth/register', input);
    // The account is created on the host for the country's data region (one host serves all by default).
    this.app.useOrigin(this.app.originForRegion(countryPolicy(input.country).region, this.apiOrigins));
    return this.appSignIn('/auth/register', input);
  }
  async login(input: { email: string; password: string }) {
    if (!this.app) return this.request<SessionInfo>('POST', '/auth/login', input);
    try {
      return await this.appSignIn('/auth/login', input);
    } catch (e) {
      // With regional hosts, an account on another host is answered with that host's origin: sign in there.
      const origin = e instanceof ApiError && e.code === 'wrong_region' ? e.detail.apiOrigin : null;
      if (typeof origin !== 'string' || !origin) throw e;
      this.app.useOrigin(origin);
      return this.appSignIn('/auth/login', input);
    }
  }
  /** App sign-in / sign-up: the response carries the token instead of setting a cookie. */
  private async appSignIn(path: string, input: unknown): Promise<SessionInfo> {
    const r = await this.request<AppSignIn>('POST', path, input);
    if (!r.token) throw new ApiError(502, 'no_token', 'The server did not start a session for the app. Try again, or update the app.');
    await this.app!.keep(r.token, r.expiresAt);
    return { account: r.account, profiles: r.profiles };
  }
  async logout() {
    try { await this.request<void>('POST', '/auth/logout'); } finally { if (this.app) await this.app.clear(); }
  }
  changePassword(currentPassword: string, newPassword: string) { return this.request<void>('POST', '/auth/password', { currentPassword, newPassword }); }
  signOutOtherSessions() { return this.request<void>('DELETE', '/auth/sessions'); }
  async deleteAccount(password: string) {
    await this.request<void>('DELETE', '/auth/account', { password });
    if (this.app) await this.app.clear();
  }
  updatePreferences(patch: { unitSystem: 'conventional' | 'si' }) { return this.request<Account>('PATCH', '/auth/preferences', patch); }
  consents() { return this.request<ConsentRecord[]>('GET', '/auth/consents'); }
  setConsent(kind: ConsentKind, granted: boolean) { return this.request<ConsentRecord[]>('PATCH', '/auth/consents', { kind, granted }); }
  activity() { return this.request<ActivityEvent[]>('GET', '/auth/activity'); }

  createProfile(input: ProfileInput, confirmation: FamilyConfirmation) { return this.request<Profile>('POST', '/profiles', { ...input, confirmation }); }
  updateProfile(id: string, patch: Partial<ProfileInput>) { return this.request<Profile>('PATCH', `/profiles/${id}`, patch); }
  deleteProfile(id: string) { return this.request<void>('DELETE', `/profiles/${id}`); }

  records(pid: string) { return this.request<ProfileRecords>('GET', `/profiles/${pid}/records`); }
  clearRecords(pid: string) { return this.request<void>('DELETE', `/profiles/${pid}/records`); }

  addMeasurements(pid: string, rows: MeasurementInput[]) { return this.request<Measurement[]>('POST', `/profiles/${pid}/measurements`, { measurements: rows }); }
  updateMeasurement(pid: string, id: string, patch: Partial<MeasurementInput>) { return this.request<Measurement>('PATCH', `/profiles/${pid}/measurements/${id}`, patch); }
  deleteMeasurement(pid: string, id: string) { return this.request<void>('DELETE', `/profiles/${pid}/measurements/${id}`); }

  uploadDocument(pid: string, file: Blob, fileName: string, kind: DocumentKind) {
    const form = new FormData();
    form.append('file', file, fileName);
    form.append('kind', kind);
    return this.request<StoredDocument>('POST', `/profiles/${pid}/documents`, form);
  }
  async documentFile(pid: string, id: string) {
    const res = await this.fetchFile(`/profiles/${pid}/documents/${id}/file?download=1`);
    if (!res.ok) throw new ApiError(res.status, 'file', res.status === 404 ? 'The original file was not found.' : 'The original file could not be loaded.');
    return res.blob();
  }
  async exportFile(pid: string) {
    const res = await this.fetchFile(`/profiles/${pid}/export`);
    if (!res.ok) throw new ApiError(res.status, 'export', 'The export could not be prepared. Try again.');
    return res.blob();
  }
  private async fetchFile(path: string): Promise<Response> {
    try {
      return await fetch(this.base() + path, await this.init('GET'));
    } catch {
      throw new ApiError(0, 'network', 'Could not reach the LotusPond server. Check your connection and try again.');
    }
  }
  deleteDocument(pid: string, id: string) { return this.request<void>('DELETE', `/profiles/${pid}/documents/${id}`); }
  // Plain links cannot carry the apps' bearer token, so the apps fetch files instead (documentFile, exportFile).
  documentUrl(pid: string, id: string, download = false) { return this.app ? null : `${BASE}/profiles/${pid}/documents/${id}/file${download ? '?download=1' : ''}`; }
  exportUrl(pid: string) { return this.app ? null : `${BASE}/profiles/${pid}/export`; }

  addScans(pid: string, scans: ScanInput[]) { return this.request<ScanItem[]>('POST', `/profiles/${pid}/scans`, { scans }); }
  updateScan(pid: string, id: string, patch: ScanPatch) { return this.request<ScanItem>('PATCH', `/profiles/${pid}/scans/${id}`, patch); }
  deleteScan(pid: string, id: string) { return this.request<void>('DELETE', `/profiles/${pid}/scans/${id}`); }

  async publicConfig() {
    const config = await this.request<PublicConfig>('GET', '/config');
    const map = config.map;
    if (!this.app || !map) return config;
    // Self-hosted tiles are given as paths on the API host (for example /api/map/files/...). The website resolves
    // them against its own address; the apps are not served from that host, so they resolve them here.
    const at = (u: string) => (u.startsWith('/') && !u.startsWith('//') ? `${this.app!.origin}${u}` : u);
    return {
      ...config,
      map: map.type === 'pmtiles' ? { ...map, url: at(map.url), assetsUrl: at(map.assetsUrl) }
        : map.type === 'style' ? { ...map, url: at(map.url) }
        : { ...map, tiles: map.tiles.map(at) },
    };
  }
  nearbyFacilities(q: FacilityQuery) {
    const params = new URLSearchParams({ lat: q.lat.toFixed(5), lon: q.lon.toFixed(5), radius: String(q.radiusKm) });
    if (q.kinds?.length) params.set('kinds', q.kinds.join(','));
    if (q.country) params.set('country', q.country);
    return this.request<FacilitySearchResult>('GET', `/facilities?${params}`);
  }
  searchPlaces(q: string) { return this.request<GeoCandidate[]>('GET', `/geo/search?${new URLSearchParams({ q })}`); }

  labCatalog(pincode: string) { return this.request<LabCatalog>('GET', `/lab/catalog?${new URLSearchParams({ pincode })}`); }
  async labSlots(q: { partner: string; pincode: string; date: string; items: string[] }) {
    const params = new URLSearchParams({ partner: q.partner, pincode: q.pincode, date: q.date, items: q.items.join(',') });
    return (await this.request<{ slots: LabSlot[] }>('GET', `/lab/slots?${params}`)).slots;
  }
  async labOrders(pid: string) { return (await this.request<{ orders: LabOrderView[] }>('GET', `/profiles/${pid}/lab-orders`)).orders; }
  async labOrder(pid: string, id: string) { return (await this.request<{ order: LabOrderView }>('GET', `/profiles/${pid}/lab-orders/${id}`)).order; }
  async bookLab(pid: string, input: LabBookingInput, idempotencyKey: string) {
    return (await this.request<{ order: LabOrderView }>('POST', `/profiles/${pid}/lab-orders`, input, { 'Idempotency-Key': idempotencyKey })).order;
  }
  async cancelLabOrder(pid: string, id: string, reason?: string) {
    return (await this.request<{ order: LabOrderView }>('POST', `/profiles/${pid}/lab-orders/${id}/cancel`, reason ? { reason } : {})).order;
  }
  async labOrderSlots(pid: string, id: string, date: string) {
    return (await this.request<{ slots: LabSlot[] }>('GET', `/profiles/${pid}/lab-orders/${id}/slots?${new URLSearchParams({ date })}`)).slots;
  }
  async rescheduleLabOrder(pid: string, id: string, slot: LabSlot) {
    return (await this.request<{ order: LabOrderView }>('POST', `/profiles/${pid}/lab-orders/${id}/reschedule`, { slot })).order;
  }
  async labResults(pid: string) { return (await this.request<{ results: LabResultView[] }>('GET', `/profiles/${pid}/lab-results`)).results; }
  labReportUrl(pid: string, rid: string) { return this.app ? null : `${BASE}/profiles/${pid}/lab-results/${rid}/report`; }
  async labReport(pid: string, rid: string) {
    const res = await this.fetchFile(`/profiles/${pid}/lab-results/${rid}/report`);
    if (!res.ok) throw new ApiError(res.status, 'file', res.status === 404 ? 'The lab report was not found.' : 'The lab report could not be loaded.');
    return res.blob();
  }
  saveLabResult(pid: string, rid: string, measurements: MeasurementInput[]) {
    return this.request<LabResultSaved>('POST', `/profiles/${pid}/lab-results/${rid}/save`, { measurements });
  }
  async dismissLabResult(pid: string, rid: string) {
    return (await this.request<{ result: LabResultView }>('POST', `/profiles/${pid}/lab-results/${rid}/dismiss`, {})).result;
  }
  reversePlace(lat: number, lon: number) {
    return this.request<GeoReverse>('GET', `/geo/reverse?${new URLSearchParams({ lat: roundCoord(lat).toFixed(2), lon: roundCoord(lon).toFixed(2) })}`);
  }

  agentConnections() { return this.request<AgentConnectionsInfo>('GET', '/agents'); }
  createAgentToken(input: CreateAgentTokenInput) { return this.request<CreatedAgentToken>('POST', '/agents/tokens', input); }
  updateAgentConnection(id: string, patch: UpdateAgentConnectionInput) { return this.request<AgentConnection>('PATCH', `/agents/${id}`, patch); }
  disconnectAgent(id: string) { return this.request<void>('DELETE', `/agents/${id}`); }
  notifications() { return this.request<NotificationList>('GET', '/notifications'); }
  markNotificationsRead(ids?: string[]) { return this.request<NotificationList>('POST', '/notifications/read', ids ? { ids } : {}); }
  undoNotification(id: string) { return this.request<UndoResult>('POST', `/notifications/${id}/undo`, {}); }

  assistantInfo() { return this.request<AssistantInfo>('GET', '/assistant'); }
  agreeToAssistant(categories: AgentCategory[]) { return this.request<AssistantConsent>('POST', '/assistant/consent', { noticeVersion: ASSISTANT_NOTICE_VERSION, categories }); }
  withdrawAssistant() { return this.request<void>('DELETE', '/assistant/consent'); }
  assistantConversation(id: string) { return this.request<{ id: string; profileId: string; title: string; channel?: 'whatsapp'; messages: AssistantMessage[] }>('GET', `/assistant/conversations/${id}`); }
  deleteAssistantConversation(id: string) { return this.request<void>('DELETE', `/assistant/conversations/${id}`); }

  whatsappInfo() { return this.request<WhatsAppInfo>('GET', '/whatsapp'); }
  startWhatsAppLink() { return this.request<WhatsAppLinkStart>('POST', '/whatsapp/link', { noticeVersion: WHATSAPP_NOTICE_VERSION }); }
  setWhatsAppProfile(profileId: string) { return this.request<WhatsAppLink>('PATCH', '/whatsapp/link', { profileId }); }
  unlinkWhatsApp() { return this.request<void>('DELETE', '/whatsapp/link'); }

  recordSources() { return this.request<SourcesInfo>('GET', '/records'); }
  recordConnections() { return this.request<RecordConnectionView[]>('GET', '/records/connections'); }
  connectRecordSource(input: { sourceId: string; profileId: string; portalUrl?: string; refreshDays: number | null }) {
    return this.request<{ connection: RecordConnectionView; run: RecordRunView | null; authorizeUrl?: string }>('POST', '/records/connections', { ...input, noticeVersion: RECORD_AGENT_NOTICE_VERSION });
  }
  updateRecordConnection(id: string, patch: { refreshDays: number | null }) { return this.request<RecordConnectionView>('PATCH', `/records/connections/${id}`, patch); }
  runRecordConnection(id: string) { return this.request<RecordRunView>('POST', `/records/connections/${id}/run`, {}); }
  disconnectRecordSource(id: string) { return this.request<void>('DELETE', `/records/connections/${id}`); }
  recordRun(id: string) { return this.request<RecordRunView>('GET', `/records/runs/${id}`); }
  answerRecordRun(id: string, answer: string) { return this.request<RecordRunView>('POST', `/records/runs/${id}/answer`, { answer }); }
  cancelRecordRun(id: string) { return this.request<RecordRunView>('POST', `/records/runs/${id}/cancel`, {}); }

  /** The answer streams back as server-sent events, one JSON AssistantEvent each. */
  async sendToAssistant(input: { profileId: string; conversationId?: string; text: string }, onEvent: (e: AssistantEvent) => void, signal?: AbortSignal) {
    const init = await this.init('POST');
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    (init.headers as Record<string, string>).Accept = 'text/event-stream';
    init.body = JSON.stringify(input);
    init.signal = signal;
    let res: Response;
    try {
      res = await fetch(this.base() + '/assistant/messages', init);
    } catch {
      if (signal?.aborted) return;
      throw new ApiError(0, 'network', 'Could not reach the LotusPond server. Check your connection and try again.');
    }
    if (!res.ok || !res.body) {
      let err: { code?: string; message?: string } | undefined;
      try { err = (await res.json() as { error?: typeof err }).error; } catch { /* not JSON */ }
      if (res.status === 401) { if (this.app) await this.app.clear(); this.onSessionEnded?.(); }
      throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `The server answered ${res.status}. Try again.`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (data) { try { onEvent(JSON.parse(data) as AssistantEvent); } catch { /* a broken event is skipped */ } }
      }
    }
  }

  extractReport(pid: string, file: Blob, fileName: string) {
    const form = new FormData();
    form.append('file', file, fileName);
    form.append('consent', 'accepted');
    form.append('noticeVersion', AI_EXTRACTION_NOTICE_VERSION);
    return this.request<AiExtraction>('POST', `/profiles/${pid}/extract`, form);
  }
}
