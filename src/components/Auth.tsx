// Screens shown before the main app: loading, storage or server unavailable, and sign in / create account.
import { useState, type FormEvent } from 'react';
import { errorMessage, isPreview } from '../api';
import { useSession } from '../state/session';
import { LIMITS } from '../../shared/constants';
import type { SignUpProblem } from '../../shared/regions';
import { guessCountry } from '../lib/country';
import { Field } from './forms';
import { checkSignUp, emptySignUp, signUpBlocked, toChoices, type SignUpDraft } from '../lib/signup';
import { SignUpDetails } from './SignUpDetails';
import { Icon, Logo } from './ui';

const ALL_REGIONS = ['in', 'eu', 'us', 'global'] as const;

export function Splash() {
  return (
    <div className="splash" role="status">
      <Logo />
      <span>Opening LotusPond…</span>
    </div>
  );
}

export function Offline() {
  const init = useSession(s => s.init);
  return (
    <div className="splash">
      <Logo />
      {isPreview ? (
        <>
          <h1>This browser is blocking site storage</h1>
          <p className="lede">The preview keeps your account and records in this browser, so it needs site data. Allow site data for this page, or open it outside a private window.</p>
        </>
      ) : (
        <>
          <h1>The LotusPond server can’t be reached</h1>
          <p className="lede">Check your connection. If you run LotusPond yourself, make sure the API server is running (<code>npm run dev</code> starts both parts).</p>
        </>
      )}
      <button className="btn btn--primary" onClick={() => void init()}>Try again</button>
    </div>
  );
}

function PondPanel() {
  return (
    <section className="auth__pond" aria-hidden={false}>
      <div className="auth__brand"><Logo /><b>LotusPond <span>Health</span></b></div>
      <div className="auth__pitch">
        <h1>Your health records, mapped to your body.</h1>
        <p>Keep lab reports and scans for you and your family in one place, and see every result on the organ it relates to.</p>
        <ul>
          <li><b>Reads your files</b> Lab report PDFs, CSV and JSON exports, DICOM scans and photos.</li>
          <li><b>One account, the whole family</b> A separate profile for each person you care for.</li>
          <li><b>Explains, never diagnoses</b> Plain-language notes and typical ranges for 95 common markers.</li>
        </ul>
      </div>
      <svg className="auth__pads" viewBox="0 0 600 220" preserveAspectRatio="xMidYMax slice" aria-hidden>
        <ellipse cx="120" cy="190" rx="150" ry="34" fill="#12353a" />
        <ellipse cx="430" cy="205" rx="190" ry="40" fill="#0f2f33" />
        <path d="M95 168c18-6 52-6 78 4-22 12-58 14-78-4z" fill="#2f7d63" opacity=".55" />
        <path d="M380 190c26-10 70-8 98 4-30 14-72 12-98-4z" fill="#2f7d63" opacity=".45" />
        <path d="M150 150c6-22 16-34 26-40 8 10 12 24 10 40-12 6-24 6-36 0z" fill="#e2869e" />
        <path d="M128 156c10-12 24-16 36-14-2 12-10 20-24 22zM198 156c-10-12-24-16-36-14 2 12 10 20 24 22z" fill="#f2b3c4" />
      </svg>
    </section>
  );
}

export function AuthScreen() {
  const { signIn, signUp, notice, service } = useSession();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<SignUpDraft>(() => emptySignUp(guessCountry()));
  const [problem, setProblem] = useState<SignUpProblem | null>(null);
  const served = service?.servedRegions ?? ALL_REGIONS;
  const blocked = mode === 'up' && signUpBlocked(details, served);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === 'up') {
      if (password.length < LIMITS.passwordMin) { setError(`Use a password of at least ${LIMITS.passwordMin} characters.`); return; }
      const p = checkSignUp(details, served);
      setProblem(p);
      if (p) { setError(p.message); return; }
    }
    setBusy(true);
    try {
      if (mode === 'in') await signIn(email, password);
      else await signUp({ displayName: name, email, password, ...toChoices(details) });
    } catch (err) {
      setError(errorMessage(err).replace(/^\w+: /, ''));
      setBusy(false);
    }
  }

  const switchTo = (m: 'in' | 'up') => { setMode(m); setError(null); setProblem(null); };
  const changeDetails = (d: SignUpDraft) => {
    setDetails(d);
    // A shown problem goes once the person has fixed it; other messages go as soon as they change something.
    if (!problem) setError(null);
    else if (checkSignUp(d, served)?.field !== problem.field) { setProblem(null); setError(null); }
  };

  return (
    <div className="auth">
      <PondPanel />
      <section className="auth__panel">
        <form className="auth__card" onSubmit={submit} noValidate>
          <div className="seg auth__tabs" role="tablist" aria-label="Account">
            <button type="button" role="tab" aria-selected={mode === 'in'} aria-pressed={mode === 'in'} onClick={() => switchTo('in')}>Sign in</button>
            <button type="button" role="tab" aria-selected={mode === 'up'} aria-pressed={mode === 'up'} onClick={() => switchTo('up')}>Create account</button>
          </div>
          <h2>{mode === 'in' ? 'Welcome back' : 'Start your record'}</h2>
          <p className="muted">{mode === 'in' ? 'Sign in to see your results and scans.' : 'Your account holds your profile and any family members you add.'}</p>
          {notice && <p className="notice" role="status">{notice}</p>}

          {mode === 'up' && (
            <Field label="Your name">{id => <input id={id} autoComplete="name" value={name} onChange={e => setName(e.target.value)} required maxLength={80} />}</Field>
          )}
          <Field label="Email">{id => <input id={id} type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required />}</Field>
          <Field label="Password" hint={mode === 'up' ? `At least ${LIMITS.passwordMin} characters. A short phrase is easy to remember.` : undefined}>
            {id => (
              <div className="pw">
                <input id={id} type={show ? 'text' : 'password'} autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
                  value={password} onChange={e => { setPassword(e.target.value); if (error) setError(null); }} required minLength={mode === 'up' ? LIMITS.passwordMin : undefined} />
                <button type="button" className="pw__toggle" onClick={() => setShow(!show)} aria-pressed={show}>{show ? 'Hide' : 'Show'}</button>
              </div>
            )}
          </Field>
          {mode === 'up' && <SignUpDetails value={details} onChange={changeDetails} servedRegions={served} problem={problem} />}

          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="btn btn--primary btn--block" disabled={busy || blocked}>
            {busy ? (mode === 'in' ? 'Signing in…' : 'Creating your account…') : mode === 'in' ? 'Sign in' : 'Create account'}
          </button>
          <p className="auth__switch">
            {mode === 'in' ? <>New to LotusPond? <button type="button" className="linkish" onClick={() => switchTo('up')}>Create an account</button></>
              : <>Already have an account? <button type="button" className="linkish" onClick={() => switchTo('in')}>Sign in</button></>}
          </p>
          <p className="auth__fine">
            {Icon.lock}
            {isPreview
              ? 'Preview: your account and records are saved in this browser only. Nothing is sent to a server.'
              : 'Files are read on your device, then stored in your account. LotusPond explains results; it does not diagnose.'}
          </p>
        </form>
      </section>
    </div>
  );
}
