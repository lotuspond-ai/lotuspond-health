// Screens shown before the main app: loading, server unreachable, sign in / create account, and first-time setup.
import { useState, type FormEvent } from 'react';
import { errorMessage, isPreview } from '../api';
import { useSession, useActiveProfile, firstName } from '../state/session';
import { LIMITS } from '../../shared/constants';
import {
  BloodTypeSelect, Field, SexChoice,
} from './forms';
import { checkDraft, fromDraft, toDraft, type ProfileDraft, todayIso } from '../lib/profile';
import { Icon, Logo } from './ui';

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
  const { signIn, signUp, notice } = useSession();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === 'up' && password.length < LIMITS.passwordMin) { setError(`Use a password of at least ${LIMITS.passwordMin} characters.`); return; }
    setBusy(true);
    try {
      if (mode === 'in') await signIn(email, password);
      else await signUp({ displayName: name, email, password });
    } catch (err) {
      setError(errorMessage(err).replace(/^\w+: /, ''));
      setBusy(false);
    }
  }

  const switchTo = (m: 'in' | 'up') => { setMode(m); setError(null); };

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
                  value={password} onChange={e => setPassword(e.target.value)} required minLength={mode === 'up' ? LIMITS.passwordMin : undefined} />
                <button type="button" className="pw__toggle" onClick={() => setShow(!show)} aria-pressed={show}>{show ? 'Hide' : 'Show'}</button>
              </div>
            )}
          </Field>

          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="btn btn--primary btn--block" disabled={busy}>
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

/** One screen after sign-up with the details that make ranges and summaries fit the person. */
export function Onboarding() {
  const profile = useActiveProfile();
  const { saveProfile, finishOnboarding } = useSession();
  const [draft, setDraft] = useState<ProfileDraft | null>(() => (profile ? toDraft(profile) : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!profile || !draft) return null;
  const errors = checkDraft(draft);
  const patch = (p: Partial<ProfileDraft>) => setDraft({ ...draft, ...p });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (Object.keys(errors).length || !profile || !draft) return;
    setBusy(true);
    try {
      const d = fromDraft(draft);
      await saveProfile(profile.id, { dateOfBirth: d.dateOfBirth, sex: d.sex, heightCm: d.heightCm, weightKg: d.weightKg, bloodType: d.bloodType });
      finishOnboarding();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="onboard">
      <form className="onboard__card" onSubmit={submit} noValidate>
        <div className="auth__brand auth__brand--ink"><Logo /><b>LotusPond <span>Health</span></b></div>
        <p className="eyebrow">Step 2 of 2 · About you</p>
        <h1>Welcome, {firstName(profile)}.</h1>
        <p className="lede">These details help LotusPond describe your results. All of them are optional, and you can change them later in your profile.</p>
        <div className="form-grid">
          <Field label="Date of birth" error={errors.dateOfBirth}>{id => <input id={id} type="date" value={draft.dateOfBirth} max={todayIso()} onChange={e => patch({ dateOfBirth: e.target.value })} />}</Field>
          <Field label="Blood type">{id => <BloodTypeSelect id={id} value={draft.bloodType} onChange={v => patch({ bloodType: v })} />}</Field>
          <Field label="Sex assigned at birth" hint="Some reference ranges differ by sex." wide>{id => <SexChoice id={id} value={draft.sex} onChange={v => patch({ sex: v })} />}</Field>
          <Field label="Height" error={errors.heightCm}>{id => <div className="unit"><input id={id} inputMode="decimal" value={draft.heightCm} onChange={e => patch({ heightCm: e.target.value })} placeholder="168" /><span>cm</span></div>}</Field>
          <Field label="Weight" error={errors.weightKg}>{id => <div className="unit"><input id={id} inputMode="decimal" value={draft.weightKg} onChange={e => patch({ weightKg: e.target.value })} placeholder="62" /><span>kg</span></div>}</Field>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="onboard__actions">
          <button type="button" className="btn btn--quiet" onClick={finishOnboarding}>Skip for now</button>
          <button className="btn btn--primary" disabled={busy || Object.keys(errors).length > 0}>{busy ? 'Saving…' : 'Continue to your body map'}</button>
        </div>
      </form>
    </div>
  );
}
