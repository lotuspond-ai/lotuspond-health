import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { backend, errorMessage, isPreview } from '../api';
import { useSession } from '../state/session';
import { toast } from '../state/toast';
import { formatDate } from '../lib/derive';
import { AGENT_CATEGORY_TEXT, type AgentCategory } from '../../shared/agents';
import { sourceById } from '../../shared/sources';
import { UNIT_SYSTEM_LABEL } from '../lib/units';
import { LIMITS } from '../../shared/constants';
import { countryInSentence, countryName, countryPolicy, storageSentence, type UnitSystem } from '../../shared/regions';
import type { ActivityEvent, AuditKind, ConsentKind, ConsentRecord, Profile } from '../types';
import { ConfirmButton, Field } from '../components/forms';
import { AppLockSettings } from '../components/AppLock';
import { siteHref, siteLinkProps } from '../site/links';
import { AgentConnectionsPanel } from '../components/AgentConnections';
import '../styles/compliance.css';

const focusDeletePassword = () => document.querySelector<HTMLInputElement>('#delete-account input[type=password]')?.focus();

export default function AccountPage() {
  const { account, profiles } = useSession();
  const { consents, activity, reload, failed } = useAccountRecords();
  if (!account) return null;
  return (
    <main className="page page--narrow">
      <div className="page__head">
        <div><h1>Account</h1><p>Sign-in, privacy and security for everyone on this account.</p></div>
      </div>
      <div className="stack">
        <section className="panel">
          <h2>Sign-in</h2>
          <dl className="facts facts--wide">
            <div><dt>Email</dt><dd>{account.email}</dd></div>
            <div><dt>Member since</dt><dd>{formatDate(account.createdAt.slice(0, 10))}</dd></div>
            <div><dt>Profiles</dt><dd>{profiles.length} {profiles.length === 1 ? 'person' : 'people'}</dd></div>
          </dl>
        </section>
        <AppLockSettings />
        <ResidencyPanel />
        {!isPreview && <AgentConnectionsPanel />}
        <UnitsPanel onChange={reload} />
        <ConsentsPanel consents={consents} failed={failed} onChange={reload} profiles={profiles} />
        <ActivityPanel activity={activity} failed={failed} profiles={profiles} />
        {!isPreview && <ContactsPanel />}
        <PasswordPanel onChange={reload} />
        {!isPreview && <DevicesPanel onChange={reload} />}
        <CreditsPanel />
        <DeletePanel />
      </div>
    </main>
  );
}

/** Consents and recent activity, loaded together and refreshed after changes on this page. */
function useAccountRecords() {
  const [consents, setConsents] = useState<ConsentRecord[] | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(() => {
    Promise.all([backend.consents(), backend.activity()])
      .then(([c, a]) => { setConsents(c); setActivity(a); setFailed(false); })
      .catch(() => setFailed(true));
  }, []);
  useEffect(reload, [reload]);
  return { consents, activity, reload, failed };
}

const dateTime = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/* ---------------- where records are kept ---------------- */

const PIN = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.4" />
  </svg>
);

function ResidencyPanel() {
  const account = useSession(s => s.account)!;
  const policy = account.country ? countryPolicy(account.country) : null;
  const region = account.region ?? policy?.region ?? 'global';
  return (
    <section className="panel" aria-labelledby="where-h">
      <h2 id="where-h">Where your records are kept</h2>
      <div className="where">
        <span className="where__pin">{PIN}</span>
        <div>
          <p className="where__lead">{isPreview ? 'Your records are stored in this browser only.' : storageSentence(region)}</p>
          {isPreview ? (
            <p className="note">This preview has no server. Clearing site data removes your account.</p>
          ) : policy ? (
            <>
              <p className="note">
                Country of residence: {countryName(policy.code)}.
                {policy.crossBorder && ` You agreed to storage outside ${countryInSentence(policy.code)} when you signed up.`}
              </p>
              <ul className="where__laws" aria-label="Laws that protect your data">{policy.laws.map(l => <li key={l}>{l}</li>)}</ul>
            </>
          ) : (
            <p className="note">This account was created before LotusPond asked for a country of residence.</p>
          )}
        </div>
      </div>
    </section>
  );
}

/* ---------------- units ---------------- */

const UNIT_EXAMPLE: Record<UnitSystem, string> = {
  conventional: 'For example, glucose 95 mg/dL and cholesterol 190 mg/dL.',
  si: 'For example, glucose 5.3 mmol/L and cholesterol 4.9 mmol/L.',
};

function UnitsPanel({ onChange }: { onChange: () => void }) {
  const unitSystem = useSession(s => s.account?.unitSystem ?? 'conventional');
  const setUnitSystem = useSession(s => s.setUnitSystem);
  const [busy, setBusy] = useState(false);
  async function choose(u: UnitSystem) {
    if (u === unitSystem || busy) return;
    setBusy(true);
    try {
      await setUnitSystem(u);
      toast.info(u === 'si' ? 'Lab values now show in SI units.' : 'Lab values now show in conventional units.');
      onChange();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-labelledby="units-h">
      <h2 id="units-h">Units for lab results</h2>
      <p className="note panel__intro">Reports keep their original values. This only changes how LotusPond shows them.</p>
      <div className="units">
        <div className="seg" role="radiogroup" aria-labelledby="units-h">
          {(['conventional', 'si'] as const).map(u => (
            <button key={u} type="button" role="radio" aria-checked={unitSystem === u} aria-pressed={unitSystem === u} disabled={busy} onClick={() => void choose(u)}>
              {UNIT_SYSTEM_LABEL[u]}
            </button>
          ))}
        </div>
        <span className="units__example">{UNIT_EXAMPLE[unitSystem]}</span>
      </div>
    </section>
  );
}

/* ---------------- consents ---------------- */

const CONSENT_LABEL: Record<ConsentKind, string> = {
  terms: 'Terms of Use',
  privacy: 'Privacy Policy',
  health_data: 'Processing your health data',
  cross_border: 'Storing records outside your country',
  marketing: 'Product emails',
  family_profile: 'Keeping a family member\'s records',
  agent_sharing: 'Sharing with an AI agent',
  ai_extraction: 'Reading a report with Claude',
  assistant: 'Using the LotusPond assistant',
  whatsapp: 'Talking with the assistant on WhatsApp',
  record_agent: 'Fetching records with the record agent',
};

/** Which profile or agent a per-item consent was for, as the history shows it. */
function consentSubject(r: ConsentRecord, profiles: Profile[]): string | null {
  const d = r.detail;
  if (!d) return null;
  const name = (id: string) => profiles.find(p => p.id === id)?.displayName ?? 'a removed profile';
  if (r.kind === 'ai_extraction' && d.profileId) return `A report for ${name(d.profileId)}`;
  if (r.kind === 'record_agent' && d.source) return `${sourceById(d.source)?.name ?? d.source}${d.profileId ? ` for ${name(d.profileId)}` : ''}`;
  if (r.kind === 'family_profile' && d.profileId) return `${name(d.profileId)}${d.confirmation === 'guardian' ? ' (as parent or guardian)' : ''}`;
  if (r.kind === 'assistant' && r.granted && d.categories) {
    return `Sees ${d.categories.length ? d.categories.map(k => AGENT_CATEGORY_TEXT[k as AgentCategory]?.title.toLowerCase()).filter(Boolean).join(', ') : 'the basics only'}`;
  }
  if (r.kind === 'agent_sharing') {
    const kinds = d.categories ? (d.categories.length ? d.categories.map(k => AGENT_CATEGORY_TEXT[k as AgentCategory]?.title.toLowerCase()).filter(Boolean).join(', ') : 'the basics only') : null;
    return [d.agent, d.profileIds?.length ? `sees ${d.profileIds.map(name).join(', ')}` : null, kinds, d.scopes?.includes('health:write') ? 'may add records' : null,
      d.expiresAt ? `until ${formatDate(d.expiresAt.slice(0, 10))}` : null].filter(Boolean).join(' · ');
  }
  return null;
}
const CONSENT_ORDER: ConsentKind[] = ['health_data', 'cross_border', 'terms', 'privacy', 'marketing'];

/** "Given", "Withdrawn" (after an earlier yes) or "Declined" (never given). Records are newest first. */
function decisionWord(records: ConsentRecord[], i: number): string {
  const r = records[i];
  if (r.granted) return 'Given';
  // Per-item consents (a profile, an agent) are withdrawn for that item, not the kind.
  const item = (x: ConsentRecord) => x.detail?.connectionId ?? x.detail?.profileId ?? null;
  return records.slice(i + 1).some(o => o.kind === r.kind && item(o) === item(r) && o.granted) ? 'Withdrawn' : 'Declined';
}

function ConsentsPanel({ consents, failed, onChange, profiles }: { consents: ConsentRecord[] | null; failed: boolean; onChange: () => void; profiles: Profile[] }) {
  const [busy, setBusy] = useState(false);
  const [explain, setExplain] = useState<ConsentKind | null>(null);
  const latest = new Map<ConsentKind, ConsentRecord>();
  for (const r of consents ?? []) if (!latest.has(r.kind)) latest.set(r.kind, r);
  const kinds = CONSENT_ORDER.filter(k => latest.has(k) || k === 'marketing');

  async function setMarketing(granted: boolean) {
    setBusy(true);
    try {
      await backend.setConsent('marketing', granted);
      toast.info(granted ? 'You will get product emails.' : 'You will not get product emails.');
      onChange();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="consent-h">
      <h2 id="consent-h">Your consent</h2>
      {failed && <p className="form-error" role="alert">Your consent records could not be loaded. Reload the page to try again.</p>}
      {!consents && !failed && <p className="note">Loading…</p>}
      {consents && (
        <>
          {consents.length === 0 && <p className="note panel__intro">This account was created before LotusPond recorded consent.</p>}
          <ul className="consent-list">
            {kinds.map(kind => {
              const r = latest.get(kind);
              const granted = !!r?.granted;
              const word = r ? decisionWord(consents, consents.indexOf(r)) : 'Not given';
              return (
                <li key={kind}>
                  <b>{CONSENT_LABEL[kind]}</b>
                  <small>{r ? `${word} ${formatDate(r.createdAt.slice(0, 10))} · version ${r.version}` : 'Not given'}</small>
                  <span className="status">
                    <span className={`pill ${granted ? 'pill--yes' : 'pill--no'}`}>{granted ? 'Given' : kind === 'marketing' ? 'Off' : 'Not given'}</span>
                    {kind === 'marketing' ? (
                      <button type="button" className="btn" disabled={busy} onClick={() => void setMarketing(!granted)}>{granted ? 'Turn off' : 'Turn on'}</button>
                    ) : granted && (kind === 'health_data' || kind === 'cross_border') ? (
                      <button type="button" className="btn btn--quiet" aria-expanded={explain === kind} onClick={() => setExplain(explain === kind ? null : kind)}>Withdraw</button>
                    ) : null}
                  </span>
                  {explain === kind && (
                    <div className="residency residency--blocked explain" role="status" style={{ gridColumn: '1 / -1' }}>
                      <b>Withdrawing this consent means deleting your account.</b>
                      <p>LotusPond cannot keep your records without it. Deleting the account removes every profile, result, scan and file on it. Download an export from each profile first if you want a copy.</p>
                      <p style={{ marginTop: 8 }}>
                        <button type="button" className="linkish" onClick={focusDeletePassword}>Go to Delete account</button>
                      </p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {consents.length > 0 && (
            <details className="history">
              <summary>Every consent decision ({consents.length})</summary>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Date</th><th>Consent</th><th>Decision</th><th>Version</th><th>Country</th></tr></thead>
                  <tbody>
                    {consents.map((r, i) => (
                      <tr key={`${r.kind}-${r.createdAt}-${i}`}>
                        <td>{dateTime(r.createdAt)}</td><td>{CONSENT_LABEL[r.kind]}{consentSubject(r, profiles) && <><br /><small>{consentSubject(r, profiles)}</small></>}</td><td>{decisionWord(consents, i)}</td><td>{r.version}</td><td>{r.country ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}

/* ---------------- activity ---------------- */

const ACTIVITY_LABEL: Record<AuditKind, string> = {
  account_created: 'Account created',
  sign_in: 'Signed in',
  sign_in_failed: 'Sign-in refused: wrong password',
  sign_out: 'Signed out',
  password_changed: 'Password changed',
  sessions_revoked: 'Other devices signed out',
  export: 'Profile exported',
  profile_deleted: 'Family member removed',
  records_deleted: 'Records deleted',
  account_deleted: 'Account deleted',
  consent_changed: 'Consent changed',
  preferences_changed: 'Units changed',
  lab_order_created: 'Lab test booked',
  lab_order_cancelled: 'Lab test booking cancelled',
  lab_results_saved: 'Lab results added',
  agent_connected: 'Agent connected',
  agent_disconnected: 'Agent disconnected',
  agent_access: 'Agent read records',
  agent_wrote: 'Agent added to records',
  agent_write_undone: 'Undid an agent’s addition',
  report_read_by_ai: 'Report read with Claude',
  assistant_chat: 'Started a chat with the assistant',
  whatsapp_linked: 'Linked a WhatsApp number',
  whatsapp_unlinked: 'Unlinked WhatsApp',
  whatsapp_report: 'Sent a report on WhatsApp',
  records_source_connected: 'Connected a record source',
  records_source_disconnected: 'Disconnected a record source',
  records_fetched: 'The record agent brought in reports',
};

function describe(e: ActivityEvent, profiles: Profile[]): string | null {
  const d = e.detail;
  if (!d) return null;
  if (e.kind === 'consent_changed' && d.consent) return `${CONSENT_LABEL[d.consent]}: ${d.granted ? 'given' : 'withdrawn'}`;
  if (e.kind === 'preferences_changed' && d.unitSystem) return UNIT_SYSTEM_LABEL[d.unitSystem];
  if (d.profileId) {
    const p = profiles.find(x => x.id === d.profileId);
    return p ? p.displayName : null;
  }
  return null;
}

function ActivityPanel({ activity, failed, profiles }: { activity: ActivityEvent[] | null; failed: boolean; profiles: Profile[] }) {
  const [all, setAll] = useState(false);
  const shown = activity ? (all ? activity : activity.slice(0, 8)) : [];
  return (
    <section className="panel" aria-labelledby="activity-h">
      <h2 id="activity-h">Recent activity</h2>
      <p className="note panel__intro">Sign-ins and changes to this account. If you see something you did not do, change your password and sign out other devices.</p>
      {failed && <p className="form-error" role="alert">Recent activity could not be loaded.</p>}
      {!activity && !failed && <p className="note">Loading…</p>}
      {activity && activity.length === 0 && <p className="note">Nothing yet.</p>}
      {shown.length > 0 && (
        <ul className="activity">
          {shown.map(e => {
            const extra = [describe(e, profiles), e.device].filter(Boolean).join(' · ');
            return (
              <li key={e.id} className={e.kind === 'sign_in_failed' ? 'is-warn' : undefined}>
                <span><b>{ACTIVITY_LABEL[e.kind] ?? e.kind}</b>{extra && <><br /><small>{extra}</small></>}</span>
                <time dateTime={e.createdAt}>{dateTime(e.createdAt)}</time>
              </li>
            );
          })}
        </ul>
      )}
      {activity && activity.length > 8 && (
        <button type="button" className="linkish" style={{ marginTop: 8 }} onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${activity.length}`}</button>
      )}
    </section>
  );
}

/* ---------------- contacts ---------------- */

/** Contact text with any email address turned into a link. */
function Contact({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/[^\s<>(),;]+@[^\s<>(),;]+\.[a-z]{2,}/gi)) {
    parts.push(text.slice(last, m.index), <a key={m.index} href={`mailto:${m[0]}`}>{m[0]}</a>);
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

function ContactsPanel() {
  const account = useSession(s => s.account)!;
  const service = useSession(s => s.service);
  const policy = account.country ? countryPolicy(account.country) : null;
  const dpo = service?.contacts.dpo;
  const grievance = service?.contacts.grievance;
  return (
    <section className="panel" aria-labelledby="contacts-h">
      <h2 id="contacts-h">Questions about your data</h2>
      <p className="note panel__intro">Ask how your data is used, ask for a correction, or make a complaint.</p>
      <dl className="contacts">
        {policy?.grievanceOfficer && (
          <div>
            <dt>Grievance officer for India (Digital Personal Data Protection Act)</dt>
            <dd>{grievance ? <Contact text={grievance} /> : 'Not published by this server yet.'}</dd>
          </div>
        )}
        <div>
          <dt>Data protection officer</dt>
          <dd>{dpo ? <Contact text={dpo} /> : 'Not published by this server yet.'}</dd>
        </div>
      </dl>
    </section>
  );
}

/* ---------------- credits ---------------- */

const CC_BY_SA = 'https://creativecommons.org/licenses/by-sa/4.0/';

/** Attribution for the anatomy, map data and fonts. The apps and the preview ship the models without the website, so
 *  the credit has to be here as well as on the credits page. */
function CreditsPanel() {
  return (
    <section className="panel" aria-labelledby="credits-h">
      <h2 id="credits-h">Credits and licences</h2>
      <p className="note panel__intro">The body on the map is adapted from openly licensed anatomical data, and you may reuse it under the same licence.</p>
      <dl className="contacts">
        <div>
          <dt>3D anatomy</dt>
          <dd>
            Adapted from the HuBMAP Human Reference Atlas (Kristen Browne, Heidi Schlehlein and colleagues, CC BY 4.0), made with data
            from the Visible Human Project of the U.S. National Library of Medicine, and from Z-Anatomy (Gauthier Kervyn, Lluís Vinent,
            CC BY-SA 4.0), based on BodyParts3D, © The Database Center for Life Science (CC BY-SA 2.1 Japan). We fitted the sources
            together, simplified and coloured them. Our models and the body map pictures are shared
            under <a href={CC_BY_SA} target="_blank" rel="noopener">CC BY-SA 4.0</a>.
          </dd>
        </div>
        <div><dt>Map data</dt><dd>© OpenStreetMap contributors, under the Open Database Licence.</dd></div>
        <div><dt>Fonts</dt><dd>Newsreader and Hanken Grotesk, under the SIL Open Font License 1.1.</dd></div>
      </dl>
      <p className="note"><a href={siteHref('/credits/')} {...siteLinkProps}>Sources, what we changed and model downloads</a></p>
    </section>
  );
}

/* ---------------- password, devices, deletion ---------------- */

function PasswordPanel({ onChange }: { onChange: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = repeat.length > 0 && repeat !== next;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < LIMITS.passwordMin) { setError(`Use at least ${LIMITS.passwordMin} characters for the new password.`); return; }
    if (next !== repeat) { setError('The new passwords do not match.'); return; }
    setBusy(true);
    try {
      await backend.changePassword(current, next);
      setCurrent(''); setNext(''); setRepeat('');
      toast.info(isPreview ? 'Password changed.' : 'Password changed. Other devices were signed out.');
      onChange();
    } catch (err) {
      setError(errorMessage(err).replace(/^\w+: /, ''));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={submit} noValidate>
      <h2>Change password</h2>
      <div className="form-grid">
        <Field label="Current password" wide>{id => <input id={id} type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} />}</Field>
        <Field label="New password" hint={`At least ${LIMITS.passwordMin} characters.`}>{id => <input id={id} type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />}</Field>
        <Field label="Repeat new password" error={mismatch ? 'The passwords do not match.' : null}>{id => <input id={id} type="password" autoComplete="new-password" value={repeat} onChange={e => setRepeat(e.target.value)} />}</Field>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="panel__actions"><button className="btn btn--primary" disabled={busy || !current || !next || !repeat}>{busy ? 'Changing…' : 'Change password'}</button></div>
    </form>
  );
}

function DevicesPanel({ onChange }: { onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <section className="panel">
      <h2>Other devices</h2>
      <p className="note" style={{ marginBottom: 12 }}>Signed in on a shared or lost device? Sign out everywhere except here.</p>
      <button className="btn" disabled={busy} onClick={async () => {
        setBusy(true);
        try { await backend.signOutOtherSessions(); toast.info('Signed out of every other device.'); onChange(); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
      }}>{busy ? 'Signing out…' : 'Sign out other devices'}</button>
    </section>
  );
}

function DeletePanel() {
  const deleteAccount = useSession(s => s.deleteAccount);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="panel panel--danger" id="delete-account">
      <h2>Delete account</h2>
      <p className="note" style={{ marginBottom: 12 }}>Permanently deletes your account, every profile on it, and all results, scans and files. It also withdraws every consent. This cannot be undone.</p>
      <div className="form-grid">
        <Field label="Enter your password to confirm" error={error}>{id => <input id={id} type="password" autoComplete="current-password" value={password} onChange={e => { setPassword(e.target.value); setError(null); }} />}</Field>
      </div>
      <div className="panel__actions">
        {password ? (
          <ConfirmButton confirmText="Delete the account and everything in it?" busyText="Deleting…"
            onConfirm={async () => { try { await deleteAccount(password); } catch (e) { setError(errorMessage(e)); } }}>
            Delete account
          </ConfirmButton>
        ) : <button className="btn btn--danger" disabled>Delete account</button>}
      </div>
    </section>
  );
}
