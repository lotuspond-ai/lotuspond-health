// Finishing sign-up after LotusPond Accounts (docs/identity.md). Accounts holds the email and password; Health still
// asks its own questions: your name, the country you live in, your age and the health-data consent.
import { useEffect, useState, type FormEvent } from 'react';
import { backend, errorMessage, inApp } from '../api';
import { startAccountsSignIn } from '../native/accounts';
import { useSession } from '../state/session';
import type { SignUpProblem } from '../../shared/regions';
import { accountsStartPath } from '../../shared/identity';
import { guessCountry } from '../lib/country';
import { checkSignUp, emptySignUp, signUpBlocked, toChoices, type SignUpDraft } from '../lib/signup';
import { Field } from './forms';
import { SignUpDetails } from './SignUpDetails';

const ALL_REGIONS = ['in', 'eu', 'us', 'global'] as const;

export function AccountsSignUp() {
  const { completeAccountsSignUp, service } = useSession();
  const [pending, setPending] = useState<{ email: string } | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [details, setDetails] = useState<SignUpDraft>(() => emptySignUp(guessCountry()));
  const [problem, setProblem] = useState<SignUpProblem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const served = service?.servedRegions ?? ALL_REGIONS;

  useEffect(() => {
    let live = true;
    (backend.accountsPending?.() ?? Promise.resolve(null)).then(p => { if (live) setPending(p); }, e => { if (live) { setPending(null); setError(errorMessage(e)); } });
    return () => { live = false; };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Enter your name.'); return; }
    const p = checkSignUp(details, served);
    setProblem(p);
    if (p) { setError(p.message); return; }
    setBusy(true);
    try {
      await completeAccountsSignUp({ displayName: name, ...toChoices(details) });
    } catch (err) {
      setError(errorMessage(err).replace(/^\w+: /, ''));
      setBusy(false);
    }
  }

  if (pending === undefined) return <p className="muted" role="status">Checking your LotusPond account…</p>;
  if (pending === null) {
    return (
      <>
        <h2>Start again</h2>
        <p className="muted">{error ?? 'That sign-up took too long, or was started in another browser.'}</p>
        {inApp
          ? <button type="button" className="btn btn--primary btn--block" onClick={() => { startAccountsSignIn('signup').catch(e => setError(errorMessage(e))); }}>Continue with LotusPond Account</button>
          : <a className="btn btn--primary btn--block" href={accountsStartPath('signup')}>Continue with LotusPond Account</a>}
      </>
    );
  }
  return (
    <form onSubmit={submit} noValidate>
      <h2>Finish creating your record</h2>
      <p className="muted">You are signed in to LotusPond as <b>{pending.email}</b>. LotusPond Health needs a few answers of its own before it keeps your health records.</p>
      <Field label="Your name">{id => <input id={id} autoComplete="name" value={name} onChange={e => setName(e.target.value)} required maxLength={80} />}</Field>
      <SignUpDetails value={details} onChange={d => { setDetails(d); if (!problem) setError(null); }} servedRegions={served} problem={problem} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn btn--primary btn--block" disabled={busy || signUpBlocked(details, served)}>
        {busy ? 'Creating your account…' : 'Create account'}
      </button>
    </form>
  );
}
