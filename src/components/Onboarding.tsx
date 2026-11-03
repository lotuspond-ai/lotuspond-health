// First-time setup after sign-up: the details that make results and nearby services fit the person.
import { useState, type FormEvent } from 'react';
import { errorMessage } from '../api';
import { useSession, useActiveProfile, firstName } from '../state/session';
import { BloodTypeSelect, Field, SexChoice } from './forms';
import { checkDraft, fromDraft, toDraft, type ProfileDraft, todayIso } from '../lib/profile';
import { Logo } from './ui';
import { OnboardingArea } from './labs/OnboardingArea';

/** One screen after sign-up with the details that make ranges and summaries fit the person. */
export function Onboarding() {
  const profile = useActiveProfile();
  const { saveProfile, finishOnboarding } = useSession();
  const [draft, setDraft] = useState<ProfileDraft | null>(() => (profile ? toDraft(profile) : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<'about' | 'area'>('about');
  if (!profile || !draft) return null;
  if (stage === 'area') return <OnboardingArea profile={profile} step="Step 3 of 3 · Your area" onDone={finishOnboarding} />;
  const errors = checkDraft(draft);
  const patch = (p: Partial<ProfileDraft>) => setDraft({ ...draft, ...p });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (Object.keys(errors).length || !profile || !draft) return;
    setBusy(true);
    try {
      const d = fromDraft(draft);
      await saveProfile(profile.id, { dateOfBirth: d.dateOfBirth, sex: d.sex, heightCm: d.heightCm, weightKg: d.weightKg, bloodType: d.bloodType });
      setBusy(false);
      setStage('area');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="onboard">
      <form className="onboard__card" onSubmit={submit} noValidate>
        <div className="auth__brand auth__brand--ink"><Logo /><b>LotusPond <span>Health</span></b></div>
        <p className="eyebrow">Step 2 of 3 · About you</p>
        <h1>Welcome, {firstName(profile)}.</h1>
        <p className="lede">These details help LotusPond describe your results and choose the body on your map. All of them are optional, and you can change them later in your profile.</p>
        <div className="form-grid">
          <Field label="Date of birth" error={errors.dateOfBirth}>{id => <input id={id} type="date" value={draft.dateOfBirth} max={todayIso()} onChange={e => patch({ dateOfBirth: e.target.value })} />}</Field>
          <Field label="Blood type">{id => <BloodTypeSelect id={id} value={draft.bloodType} onChange={v => patch({ bloodType: v })} />}</Field>
          <Field label="Sex assigned at birth" hint="Picks the body on the map (the female body for Intersex and Not set); you can choose another on your Profile page. Some reference ranges differ by sex." wide>{id => <SexChoice id={id} value={draft.sex} onChange={v => patch({ sex: v })} />}</Field>
          <Field label="Height" error={errors.heightCm}>{id => <div className="unit"><input id={id} inputMode="decimal" value={draft.heightCm} onChange={e => patch({ heightCm: e.target.value })} placeholder="168" /><span>cm</span></div>}</Field>
          <Field label="Weight" error={errors.weightKg}>{id => <div className="unit"><input id={id} inputMode="decimal" value={draft.weightKg} onChange={e => patch({ weightKg: e.target.value })} placeholder="62" /><span>kg</span></div>}</Field>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="onboard__actions">
          <button type="button" className="btn btn--quiet" onClick={() => setStage('area')}>Skip for now</button>
          <button className="btn btn--primary" disabled={busy || Object.keys(errors).length > 0}>{busy ? 'Saving…' : 'Continue'}</button>
        </div>
      </form>
    </div>
  );
}
