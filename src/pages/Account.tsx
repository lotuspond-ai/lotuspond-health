import { useState, type FormEvent } from 'react';
import { backend, errorMessage, isPreview } from '../api';
import { useSession } from '../state/session';
import { toast } from '../state/toast';
import { formatDate } from '../lib/derive';
import { LIMITS } from '../../shared/constants';
import { ConfirmButton, Field } from '../components/forms';

export default function AccountPage() {
  const { account, profiles } = useSession();
  if (!account) return null;
  return (
    <main className="page page--narrow">
      <div className="page__head">
        <div><h1>Account</h1><p>Sign-in details and security for everyone on this account.</p></div>
      </div>
      <div className="stack">
        <section className="panel">
          <h2>Sign-in</h2>
          <dl className="facts facts--wide">
            <div><dt>Email</dt><dd>{account.email}</dd></div>
            <div><dt>Member since</dt><dd>{formatDate(account.createdAt.slice(0, 10))}</dd></div>
            <div><dt>Profiles</dt><dd>{profiles.length} {profiles.length === 1 ? 'person' : 'people'}</dd></div>
            <div><dt>Where records are kept</dt><dd>{isPreview ? 'In this browser only (preview)' : 'On the LotusPond server, in your account'}</dd></div>
          </dl>
          {isPreview && <p className="note" style={{ marginTop: 12 }}>This preview has no server, so your account works only in this browser. Clearing site data removes it.</p>}
        </section>
        <PasswordPanel />
        {!isPreview && <DevicesPanel />}
        <DeletePanel />
      </div>
    </main>
  );
}

function PasswordPanel() {
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

function DevicesPanel() {
  const [busy, setBusy] = useState(false);
  return (
    <section className="panel">
      <h2>Other devices</h2>
      <p className="note" style={{ marginBottom: 12 }}>Signed in on a shared or lost device? Sign out everywhere except here.</p>
      <button className="btn" disabled={busy} onClick={async () => {
        setBusy(true);
        try { await backend.signOutOtherSessions(); toast.info('Signed out of every other device.'); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
      }}>{busy ? 'Signing out…' : 'Sign out other devices'}</button>
    </section>
  );
}

function DeletePanel() {
  const deleteAccount = useSession(s => s.deleteAccount);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="panel panel--danger">
      <h2>Delete account</h2>
      <p className="note" style={{ marginBottom: 12 }}>Permanently deletes your account, every profile on it, and all results, scans and files. This cannot be undone.</p>
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
