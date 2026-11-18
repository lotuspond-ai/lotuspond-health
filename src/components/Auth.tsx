// Screens shown before the main app: loading, storage or server unavailable, and sign in / create account.
import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage, inApp, isPreview } from '../api';
import { useSession } from '../state/session';
import { LIMITS } from '../../shared/constants';
import type { SignUpProblem } from '../../shared/regions';
import { guessCountry } from '../lib/country';
import { Field } from './forms';
import { checkSignUp, emptySignUp, signUpBlocked, toChoices, type SignUpDraft } from '../lib/signup';
import { SignUpDetails } from './SignUpDetails';
import { AccountsSignUp } from './AccountsSignUp';
import { startAccountsSignIn } from '../native/accounts';
import { ACCOUNTS_ERRORS, accountsStartPath } from '../../shared/identity';
import { ServerPicker } from './ServerPicker';
import { Icon, Logo } from './ui';
import { accountsReturn, onAuthHash, showAuthMode, siteHref, siteLinkProps, type AuthMode } from '../site/links';
import '../styles/auth-site.css';

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
          <p className="lede">{inApp ? 'Check that your phone is online, then try again.'
            : <>Check your connection. If you run LotusPond yourself, make sure the API server is running (<code>npm run dev</code> starts both parts).</>}</p>
        </>
      )}
      <button className="btn btn--primary" onClick={() => void init()}>Try again</button>
      <ServerPicker />
    </div>
  );
}

function PondPanel() {
  return (
    <section className="auth__pond" aria-hidden={false}>
      <a className="auth__brand" href={siteHref('/')} {...siteLinkProps} aria-label="LotusPond Health home"><Logo /><b>LotusPond <span>Health</span></b></a>
      <div className="auth__pitch">
        <h1>Your family’s health records, ready for any AI agent.</h1>
        <p>Bring your reports in from labs, hospitals, ABHA and your devices, and use them with Claude, ChatGPT or any agent you choose.</p>
        <ul>
          <li><b>Brings your records in</b> From labs, hospitals, ABHA, DigiLocker and wearables, or a PDF or photo you upload.</li>
          <li><b>Works with your AI</b> You choose whose records each agent sees, and can disconnect it at any time.</li>
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

export function AuthScreen({ initialMode = 'in' }: { initialMode?: AuthMode }) {
  const { signIn, signUp, notice, service, accountsPending } = useSession();
  const [mode, setMode] = useState<AuthMode>(initialMode);
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
  // Sign-in through LotusPond Accounts, when the server has it switched on (docs/identity.md): the website goes
  // through its own page, the apps through the system browser (src/native/accounts.ts).
  const accountsOn = !!service?.accounts && !isPreview;
  // Health's own password form, until LotusPond Accounts is the only way in (PASSWORD_SIGN_IN=off).
  const passwordOn = service?.passwordSignIn !== false || isPreview;
  const accountsButton = (primary: boolean) => inApp ? (
    <button type="button" className={`btn btn--block${primary ? ' btn--primary' : ''}`} onClick={() => {
      setError(null);
      startAccountsSignIn(mode === 'up' ? 'signup' : 'login').catch(e => setError(errorMessage(e).replace(/^\w+: /, '')));
    }}>Continue with LotusPond Account</button>
  ) : <a className={`btn btn--block${primary ? ' btn--primary' : ''}`} href={accountsStartPath(mode === 'up' ? 'signup' : 'login', accountsReturn())}>Continue with LotusPond Account</a>;
  const [search] = useState(() => {
    const read = new URLSearchParams(window.location.search);
    // The error is shown once; it does not stay in the address.
    if (read.has('accounts_error')) {
      const rest = new URLSearchParams(read);
      rest.delete('accounts_error');
      try { history.replaceState(history.state, '', `${location.pathname}${rest.size ? `?${rest}` : ''}${location.hash}`); } catch { /* sandboxed frame */ }
    }
    return read;
  });
  const finishingAccounts = !isPreview && (inApp ? accountsPending : search.get('accounts') === 'continue');
  const accountsError = search.get('accounts_error');
  const accountsNotice = accountsError ? (ACCOUNTS_ERRORS as Record<string, string>)[accountsError] ?? ACCOUNTS_ERRORS.sign_in_failed : null;

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
  useEffect(() => showAuthMode(mode), [mode]);
  useEffect(() => onAuthHash(m => { setMode(m); setError(null); setProblem(null); }), []);
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
        {finishingAccounts ? <div className="auth__card"><AccountsSignUp /></div> : (
        <form className="auth__card" onSubmit={submit} noValidate>
          <div className="seg auth__tabs" role="tablist" aria-label="Account">
            <button type="button" role="tab" aria-selected={mode === 'in'} aria-pressed={mode === 'in'} onClick={() => switchTo('in')}>Sign in</button>
            <button type="button" role="tab" aria-selected={mode === 'up'} aria-pressed={mode === 'up'} onClick={() => switchTo('up')}>Create account</button>
          </div>
          <h2>{mode === 'in' ? 'Welcome back' : 'Start your record'}</h2>
          <p className="muted">{mode === 'in' ? 'Sign in to see your results and scans.' : 'Your account holds your profile and any family members you add.'}</p>
          {notice && <p className="notice" role="status">{notice}</p>}
          {accountsNotice && <p className="form-error" role="alert">{accountsNotice}</p>}

          {passwordOn ? (<>
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
          {accountsOn && (
            <>
              <p className="auth__or"><span>or</span></p>
              {accountsButton(false)}
            </>
          )}
          </>) : (
            <>
              <p className="muted">LotusPond Health uses your LotusPond account, the one account for LotusPond Health and LotusPond Works.</p>
              {error && <p className="form-error" role="alert">{error}</p>}
              {accountsButton(true)}
            </>
          )}
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
          <nav className="auth__site" aria-label="LotusPond Health website">
            <a href={siteHref('/privacy/')} {...siteLinkProps}>Privacy</a>
            <a href={siteHref('/terms/')} {...siteLinkProps}>Terms</a>
            <a href={siteHref('/trust/')} {...siteLinkProps}>Trust and compliance</a>
          </nav>
        </form>
        )}
        <ServerPicker />
      </section>
    </div>
  );
}
