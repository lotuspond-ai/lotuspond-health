// Sources: where the family's records live, and the record agent that brings them in (shared/sources.ts,
// docs/record-agent.md). Connect a portal for a profile; the agent opens it in a browser of its own, asks here for
// the mobile number and the code the portal sends, downloads the reports and saves new ones to Files for review.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { backend, errorMessage, isPreview } from '../api';
import { useSession } from '../state/session';
import { useUI } from '../state/ui';
import { useHealth } from '../lib/store';
import { toast } from '../state/toast';
import { ConfirmButton, Field } from '../components/forms';
import { Icon } from '../components/ui';
import {
  REFRESH_CHOICES, SOURCE_ACCESS_TEXT, SOURCE_CATEGORY_TEXT,
  type RecordConnectionView, type RecordRunView, type SourceCategory, type SourcesInfo, type SourceView,
} from '../../shared/sources';
import '../styles/sources.css';

const CATEGORIES = Object.keys(SOURCE_CATEGORY_TEXT) as SourceCategory[];
const ACTIVE = new Set(['queued', 'running', 'waiting']);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null);
const refreshLabel = (d: number | null) => REFRESH_CHOICES.find(c => c.days === d)?.label ?? 'Only when I ask';

function badge(s: SourceView): { text: string; tone: 'ok' | 'beta' | 'soon' } {
  if (s.availability === 'recipe') return { text: 'Ready', tone: 'ok' };
  if (s.availability === 'navigator') return { text: 'Beta', tone: 'beta' };
  if (s.access === 'app') return { text: 'In LotusPond', tone: 'ok' };
  if (s.availability === 'abdm') return { text: 'Ready · ABDM', tone: 'ok' };
  if (s.availability === 'api') return { text: 'Ready', tone: 'ok' };
  if (s.access === 'abdm') return { text: 'Coming with ABDM', tone: 'soon' };
  return { text: 'Coming soon', tone: 'soon' };
}

export default function SourcesPage() {
  const [info, setInfo] = useState<SourcesInfo | null>(null);
  const [conns, setConns] = useState<RecordConnectionView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [connecting, setConnecting] = useState<SourceView | null>(null);
  const [category, setCategory] = useState<SourceCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const reload = useCallback(() => {
    Promise.all([backend.recordSources(), backend.recordConnections()])
      .then(([i, c]) => { setInfo(i); setConns(c); setFailed(false); }, () => setFailed(true));
  }, []);
  useEffect(reload, [reload]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (info?.sources ?? []).filter(s => (category === 'all' || s.category === category)
      && (!q || `${s.name} ${s.holds.join(' ')}`.toLowerCase().includes(q)));
  }, [info, category, query]);

  return (
    <main className="page page--narrow sources">
      <div className="page__head">
        <div>
          <h1>Sources</h1>
          <p>Bring in reports from labs, hospitals, government services and insurers. The record agent signs in with you, downloads your reports and saves new ones to Files for you to check.</p>
        </div>
      </div>
      {isPreview && <p className="note">The record agent runs on the LotusPond server. This preview has none, so it can only show the list.</p>}
      {failed && <p className="form-error" role="alert">Sources could not be loaded. Try again in a moment.</p>}
      {info && !info.enabled && !isPreview && <p className="note">The record agent is not switched on for this server yet. You can still upload reports, or forward them on WhatsApp.</p>}

      {conns && conns.length > 0 && (
        <section className="panel" aria-labelledby="connected-h">
          <h2 id="connected-h">Connected</h2>
          <ul className="sources__connected">
            {conns.map(c => <Connection key={c.id} conn={c} onChange={reload} />)}
          </ul>
        </section>
      )}

      <section className="panel" aria-labelledby="catalogue-h">
        <h2 id="catalogue-h">Add a source</h2>
        <div className="sources__filters">
          <div className="seg sources__cats" role="group" aria-label="Kind of source">
            <button aria-pressed={category === 'all'} onClick={() => setCategory('all')}>All</button>
            {CATEGORIES.map(k => <button key={k} aria-pressed={category === k} onClick={() => setCategory(k)}>{SOURCE_CATEGORY_TEXT[k].title}</button>)}
          </div>
          <label className="sources__search"><span className="sr-only">Search sources</span>
            <input type="search" placeholder="Search, e.g. Thyrocare or discharge summary" value={query} onChange={e => setQuery(e.target.value)} />
          </label>
        </div>
        {category !== 'all' && <p className="note">{SOURCE_CATEGORY_TEXT[category].detail}</p>}
        {info && !shown.length && <p className="note">No source matches that search.</p>}
        <ul className="sources__grid">
          {shown.map(s => {
            const b = badge(s);
            const canConnect = !!info?.enabled && (s.availability === 'recipe' || s.availability === 'navigator' || s.availability === 'abdm' || s.availability === 'api');
            return (
              <li key={s.id} className="sources__card">
                <div className="sources__card-head"><b>{s.name}</b><span className={`sources__badge sources__badge--${b.tone}`}>{b.text}</span></div>
                <small>{s.holds.join(' · ')}</small>
                <small className="note">{s.availability === 'navigator' ? 'Claude finds its way around this portal with you. It is new; check what it saves.'
                  : (s.availability !== 'unavailable' && s.readyNote) || s.note || SOURCE_ACCESS_TEXT[s.access]}</small>
                {canConnect && <button type="button" className="btn btn--small btn--primary" onClick={() => setConnecting(s)}>Connect</button>}
              </li>
            );
          })}
        </ul>
      </section>
      {connecting && info && <ConnectDialog source={connecting} info={info} onClose={changed => { setConnecting(null); if (changed) reload(); }} />}
    </main>
  );
}

/** One connected source: its schedule, its last run (live while it runs) and what can be done with it. */
function Connection({ conn, onChange }: { conn: RecordConnectionView; onChange: () => void }) {
  const profiles = useSession(s => s.profiles);
  const [run, setRun] = useState<RecordRunView | null>(conn.lastRun);
  // A reload brings a newer last run: show it (adjusting state while rendering, not in an effect).
  const [seen, setSeen] = useState(conn.lastRun);
  if (seen !== conn.lastRun) { setSeen(conn.lastRun); setRun(conn.lastRun); }
  const who = profiles.find(p => p.id === conn.profileId)?.displayName ?? 'a profile';
  const live = !!run && ACTIVE.has(run.status);
  const status = conn.status === 'needs_sign_in' ? 'Needs you to sign in again'
    : conn.lastSuccessAt ? `Last checked ${when(conn.lastSuccessAt)}` : 'Not checked yet';
  return (
    <li className="sources__conn">
      <div className="sources__conn-head">
        <div>
          <b>{conn.sourceName}</b>
          <small>For {who}{conn.identifier ? ` · signs in as ${conn.identifier}` : ''}{conn.portalUrl ? ` · ${new URL(conn.portalUrl).hostname}` : ''}</small>
          <small className={conn.status === 'needs_sign_in' ? 'sources__warn' : undefined}>
            {status} · {conn.reportsSaved} report{conn.reportsSaved === 1 ? '' : 's'} brought in · {refreshLabel(conn.refreshDays)}{conn.nextRunAt ? `, next ${when(conn.nextRunAt)}` : ''}
          </small>
        </div>
        <div className="agents__row-actions">
          {!live && <button type="button" className="btn btn--small btn--primary" onClick={async () => {
            try {
              if (conn.status !== 'needs_sign_in') { setRun(await backend.runRecordConnection(conn.id)); return; }
              // Signing in again: a source with its own sign-in page sends the person there; the others start a run.
              const r = await backend.connectRecordSource({ sourceId: conn.sourceId, profileId: conn.profileId, refreshDays: conn.refreshDays, ...(conn.portalUrl ? { portalUrl: conn.portalUrl } : {}) });
              if (r.authorizeUrl) { location.assign(r.authorizeUrl); return; }
              if (r.run) setRun(r.run);
            } catch (e) { toast.error(errorMessage(e)); }
          }}>{conn.status === 'needs_sign_in' ? 'Sign in' : 'Check now'}</button>}
          <label><span className="sr-only">How often to check {conn.sourceName}</span>
            <select value={conn.refreshDays ?? 'never'} onChange={async e => {
              const v = e.target.value === 'never' ? null : Number(e.target.value);
              try { await backend.updateRecordConnection(conn.id, { refreshDays: v }); onChange(); } catch (err) { toast.error(errorMessage(err)); }
            }}>
              {REFRESH_CHOICES.map(c => <option key={c.days ?? 'never'} value={c.days ?? 'never'}>{c.label}</option>)}
            </select>
          </label>
          <ConfirmButton confirmText={`Disconnect ${conn.sourceName}? Reports already saved stay in Files.`} busyText="Disconnecting…" className="btn btn--small btn--danger"
            onConfirm={async () => { try { await backend.disconnectRecordSource(conn.id); toast.info(`${conn.sourceName} disconnected.`); onChange(); } catch (e) { toast.error(errorMessage(e)); } }}>Disconnect</ConfirmButton>
        </div>
      </div>
      {run && <RunPanel run={run} profileId={conn.profileId} viaApi={conn.sourceId === 'abha'} onUpdate={r => { setRun(r); if (!ACTIVE.has(r.status)) onChange(); }} />}
    </li>
  );
}

/** A run as it happens: what the agent is doing, its question for the person, then what it saved. */
function RunPanel({ run, profileId, onUpdate, viaApi = false }: { run: RecordRunView; profileId: string; onUpdate: (r: RecordRunView) => void; viaApi?: boolean }) {
  const live = ACTIVE.has(run.status);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const asked = run.question?.askedAt;
  const field = useRef<HTMLInputElement>(null);
  // A new question clears the last answer.
  const [askedSeen, setAskedSeen] = useState(asked);
  if (askedSeen !== asked) { setAskedSeen(asked); setAnswer(''); }
  useEffect(() => { if (asked) field.current?.focus(); }, [asked]);
  const latest = useRef(onUpdate);
  useEffect(() => { latest.current = onUpdate; });

  useEffect(() => {
    if (!live) return;
    let stop = false;
    const t = setInterval(async () => {
      try {
        const next = await backend.recordRun(run.id);
        if (stop) return;
        latest.current(next);
        // New reports: refresh Files for the profile on screen.
        if (next.status === 'succeeded' && next.saved && useHealth.getState().profileId === profileId) void useHealth.getState().openProfile(profileId);
      } catch { /* the next check tries again */ }
    }, 1200);
    return () => { stop = true; clearInterval(t); };
  }, [live, run.id, profileId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!answer.trim()) return;
    setBusy(true);
    try { onUpdate(await backend.answerRecordRun(run.id, answer.trim())); setAnswer(''); } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  }
  const review = (documentId: string) => {
    if (useSession.getState().activeId !== profileId) useSession.getState().switchProfile(profileId);
    useUI.getState().openReview({ profileId, documentId });
  };

  if (!live && run.status === 'succeeded') {
    return (
      <div className="sources__run sources__run--done" role="status">
        <p>{run.saved ? `Saved ${run.saved} new report${run.saved === 1 ? '' : 's'} to Files.` : `Checked ${when(run.finishedAt)}: ${run.found ? 'no new reports' : 'no reports found'}.`}</p>
        {run.note && <p className="muted">{run.note}</p>}
        {run.documents.length > 0 && (
          <ul>{run.documents.map(d => <li key={d.id}><span>{d.fileName}</span><button type="button" className="btn btn--small" onClick={() => review(d.id)}>Check results</button></li>)}</ul>
        )}
      </div>
    );
  }
  if (!live) {
    if (run.status === 'cancelled') return null;
    return <div className="sources__run sources__run--failed" role="alert"><p>{run.error ?? 'The agent stopped.'}</p></div>;
  }
  const q = run.question;
  const inputType = q?.kind === 'password' || q?.secret ? 'password' : q?.kind === 'phone' ? 'tel' : 'text';
  return (
    <div className="sources__run" aria-live="polite">
      <p className="sources__step"><span className="dots" aria-hidden="true"><i /><i /><i /></span> {q ? 'Waiting for you' : run.step ?? 'Working'}</p>
      {q && (
        <form className="sources__ask" onSubmit={submit}>
          <label htmlFor={`ask-${run.id}`}>{q.label}</label>
          {q.hint && <small className="note">{q.hint}</small>}
          <div className="sources__ask-row">
            <input id={`ask-${run.id}`} ref={field} type={inputType} value={answer} onChange={e => setAnswer(e.target.value)} maxLength={200}
              inputMode={q.kind === 'otp' || q.kind === 'phone' ? 'numeric' : undefined} autoComplete={q.kind === 'otp' ? 'one-time-code' : q.kind === 'phone' ? 'tel' : 'off'} />
            <button className="btn btn--primary" disabled={busy || !answer.trim()}>{busy ? 'Sending…' : 'Send'}</button>
          </div>
          <small className="note">{viaApi ? 'Goes straight to ABDM, through Eka Care. LotusPond does not keep it.' : 'Goes straight to the portal in the agent’s browser. LotusPond does not keep it.'}</small>
        </form>
      )}
      <button type="button" className="btn btn--small" onClick={async () => { try { onUpdate(await backend.cancelRecordRun(run.id)); } catch (e) { toast.error(errorMessage(e)); } }}>Stop</button>
    </div>
  );
}

/** The notice, whose records, the portal address when there is no fixed one, and how often to check. */
function ConnectDialog({ source, info, onClose }: { source: SourceView; info: SourcesInfo; onClose: (changed: boolean) => void }) {
  const profiles = useSession(s => s.profiles);
  const activeId = useSession(s => s.activeId);
  const [profileId, setProfileId] = useState(activeId ?? profiles[0]?.id ?? '');
  const [portalUrl, setPortalUrl] = useState('');
  const [refresh, setRefresh] = useState<number | null>(30);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<RecordRunView | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (source.needsUrl && !/^https:\/\//i.test(portalUrl.trim())) { setError('Give the portal’s full address, starting with https://'); return; }
    setBusy(true);
    try {
      const r = await backend.connectRecordSource({ sourceId: source.id, profileId, refreshDays: refresh, ...(source.needsUrl ? { portalUrl: portalUrl.trim() } : {}) });
      // A source with its own sign-in page (Withings): the person signs in there and comes back to Sources.
      if (r.authorizeUrl) { location.assign(r.authorizeUrl); return; }
      setRun(r.run);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const close = () => onClose(!!run);
  return (
    <div className="scrim" onClick={close}>
      <div className="dialog dialog--narrow sources__dialog" role="dialog" aria-modal="true" aria-labelledby="connect-h" onClick={e => e.stopPropagation()}>
        <div className="dialog__head">
          <div><h2 id="connect-h">{source.name}</h2><p className="muted">{source.holds.join(' · ')}</p></div>
          <button type="button" className="btn btn--quiet x" onClick={close} aria-label="Close">{Icon.close}</button>
        </div>
        {!run && (
          <form onSubmit={submit} noValidate>
            <ul className="sources__notice">
              {source.availability === 'api' ? (<>
                <li>You sign in on {source.name}’s own page and choose what to share. LotusPond never sees your {source.name} password.</li>
                {source.category === 'inbox' ? (<>
                  <li>LotusPond asks for read-only access. It looks only at emails from labs, hospitals and pharmacies, or whose subject names a lab report, test result, prescription or discharge summary.</li>
                  <li>From those it saves the PDF reports. It does not read or keep the emails themselves, and skips bills and invoices.</li>
                </>) : (
                  <li>LotusPond reads your measurements through {source.name}’s official API, one value per day, and never writes anything back.</li>
                )}
                <li>It keeps the sign-in, encrypted, to check again on the schedule you choose. Disconnect to forget it; you can also remove LotusPond in your {source.name} account.</li>
                <li>{source.category === 'inbox' ? 'New reports' : 'New readings'} are saved to Files. They join your records only after you check them.</li>
              </>) : source.availability === 'abdm' ? (<>
                <li>LotusPond signs in to your ABHA through Eka Care, which connects apps to ABDM. There is no browser: it asks you here for your ABHA address or number and the OTP ABDM sends.</li>
                <li>It asks ABDM for your consent to read the records hospitals and labs linked to your ABHA, and you approve it here with your ABHA consent PIN (or in your ABHA app). It never keeps codes or PINs.</li>
                <li>Eka Care fetches the records from those hospitals and labs and passes them to LotusPond. LotusPond keeps your Eka id and ABHA address, encrypted, to check again on the schedule you choose. Disconnect to forget them; revoke the consent in your ABHA app to stop ABDM sharing.</li>
                <li>New records are saved to Files. Their results join your records only after you check them.</li>
              </>) : (<>
              <li>The record agent opens {source.name} in a browser of its own, on {info.browser ?? 'LotusPond’s servers'}. It can only reach that portal.</li>
              <li>It asks you here for your mobile number and the code the portal sends you, and types them in. It never keeps codes or passwords.</li>
              <li>It keeps the portal’s sign-in, encrypted, so it can check again on the schedule you choose. Disconnect to forget it.</li>
              <li>New reports are saved to Files. Their results join your records only after you check them.</li>
              {source.availability === 'navigator' && <li>There is no fixed recipe for this portal yet, so Claude (Anthropic) reads its pages to find your reports. It does not see what you type.</li>}
              </>)}
              <li>Use it only for your own accounts, or a family member’s with their permission.</li>
            </ul>
            <div className="form-grid">
              <Field label="Whose records">{id => (
                <select id={id} value={profileId} onChange={e => setProfileId(e.target.value)}>
                  {profiles.map(p => <option key={p.id} value={p.id}>{p.displayName}{p.relationship === 'self' ? ' (you)' : ''}</option>)}
                </select>
              )}</Field>
              <Field label="Check for new reports">{id => (
                <select id={id} value={refresh ?? 'never'} onChange={e => setRefresh(e.target.value === 'never' ? null : Number(e.target.value))}>
                  {REFRESH_CHOICES.map(c => <option key={c.days ?? 'never'} value={c.days ?? 'never'}>{c.label}</option>)}
                </select>
              )}</Field>
              {source.needsUrl && (
                <Field label="Portal address" hint="The page where you sign in to see your reports." wide>{id => (
                  <input id={id} type="url" inputMode="url" placeholder="https://reports.yourlab.in" value={portalUrl} onChange={e => setPortalUrl(e.target.value)} />
                )}</Field>
              )}
            </div>
            <label className="confirm-check"><input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} /><span>I agree, and this is my account or I have permission to use it.</span></label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="dialog__actions">
              <button type="button" className="btn" onClick={() => onClose(false)} disabled={busy}>Cancel</button>
              <button className="btn btn--primary" disabled={!agreed || busy || !profileId}>{busy ? 'Starting…' : 'Connect and fetch'}</button>
            </div>
          </form>
        )}
        {run && (
          <>
            <RunPanel run={run} profileId={profileId} onUpdate={setRun} viaApi={source.availability === 'abdm'} />
            <div className="dialog__actions"><button type="button" className="btn btn--primary" onClick={() => onClose(true)}>{ACTIVE.has(run.status) ? 'Carry on in the background' : 'Done'}</button></div>
          </>
        )}
      </div>
    </div>
  );
}
