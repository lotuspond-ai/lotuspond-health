// Backend that talks to the LotusPond API on the same origin (/api).
import type { DocumentKind, Measurement, MeasurementInput, Profile, ProfileInput, ProfileRecords, ScanInput, ScanItem, SessionInfo, StoredDocument } from '../types';
import { ApiError, type Backend, type ScanPatch } from './backend';

const BASE = '/api';

export class HttpBackend implements Backend {
  readonly kind = 'server' as const;
  /** Called when a request fails because the session ended (for example, signed out on another device). */
  onSessionEnded: (() => void) | null = null;

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    }
    let res: Response;
    try {
      res = await fetch(BASE + path, init);
    } catch {
      throw new ApiError(0, 'network', 'Could not reach the LotusPond server. Check your connection and try again.');
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
      if (res.status === 401 && !path.startsWith('/auth/')) this.onSessionEnded?.();
      throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `The server answered ${res.status}. Try again.`);
    }
    return data as T;
  }

  async me() {
    try {
      return await this.request<SessionInfo | null>('GET', '/auth/me');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  }
  register(input: { email: string; password: string; displayName: string }) { return this.request<SessionInfo>('POST', '/auth/register', input); }
  login(input: { email: string; password: string }) { return this.request<SessionInfo>('POST', '/auth/login', input); }
  logout() { return this.request<void>('POST', '/auth/logout'); }
  changePassword(currentPassword: string, newPassword: string) { return this.request<void>('POST', '/auth/password', { currentPassword, newPassword }); }
  signOutOtherSessions() { return this.request<void>('DELETE', '/auth/sessions'); }
  deleteAccount(password: string) { return this.request<void>('DELETE', '/auth/account', { password }); }

  createProfile(input: ProfileInput) { return this.request<Profile>('POST', '/profiles', input); }
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
    const res = await fetch(`${BASE}/profiles/${pid}/documents/${id}/file?download=1`, { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, 'file', res.status === 404 ? 'The original file was not found.' : 'The original file could not be loaded.');
    return res.blob();
  }
  deleteDocument(pid: string, id: string) { return this.request<void>('DELETE', `/profiles/${pid}/documents/${id}`); }
  documentUrl(pid: string, id: string, download = false) { return `${BASE}/profiles/${pid}/documents/${id}/file${download ? '?download=1' : ''}`; }
  exportUrl(pid: string) { return `${BASE}/profiles/${pid}/export`; }

  addScans(pid: string, scans: ScanInput[]) { return this.request<ScanItem[]>('POST', `/profiles/${pid}/scans`, { scans }); }
  updateScan(pid: string, id: string, patch: ScanPatch) { return this.request<ScanItem>('PATCH', `/profiles/${pid}/scans/${id}`, patch); }
  deleteScan(pid: string, id: string) { return this.request<void>('DELETE', `/profiles/${pid}/scans/${id}`); }
}
