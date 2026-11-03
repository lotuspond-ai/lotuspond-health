import { useMemo, useState, type FormEvent } from 'react';
import type { Profile, Relationship } from '../types';
import { backend, errorMessage } from '../api';
import { useHealth, dates } from '../lib/store';
import { formatDate } from '../lib/derive';
import { ageFrom, RELATIONSHIP_LABEL, useActiveProfile, useMeasurementSystem, useSession } from '../state/session';
import { useUI } from '../state/ui';
import { toast } from '../state/toast';
import {
  Avatar, BloodTypeSelect, ConfirmButton, Field, SexChoice, TagInput,
} from '../components/forms';
import { bmiOf, checkDraft, fromDraft, toDraft, type ProfileDraft, todayIso } from '../lib/profile';
import { Icon } from '../components/ui';
import { HomeAreaPanel } from '../components/labs/HomeAreaPanel';
import { HeightInput, WeightInput } from '../components/MeasureInputs';
import { IMPERIAL_ERRORS } from '../lib/measures';

const FAMILY: Relationship[] = ['partner', 'child', 'parent', 'sibling', 'other'];

export default function ProfilePage() {
  const profile = useActiveProfile();
  if (!profile) return null;
  return <ProfileEditor key={`${profile.id}:${profile.updatedAt}`} profile={profile} />;
}

function ProfileEditor({ profile }: { profile: Profile }) {
  const saveProfile = useSession(s => s.saveProfile);
  const [draft, setDraft] = useState<ProfileDraft>(() => toDraft(profile));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useMemo(() => JSON.stringify(toDraft(profile)), [profile]);
  const dirty = JSON.stringify(draft) !== saved;
  const errors = checkDraft(draft);
  const patch = (p: Partial<ProfileDraft>) => setDraft({ ...draft, ...p });
  const isSelf = profile.relationship === 'self';
  const age = ageFrom(draft.dateOfBirth || null);
  const d = fromDraft(draft);
  const bmi = bmiOf(d.heightCm ?? null, d.weightKg ?? null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (Object.keys(errors).length) return;
    setBusy(true);
    setError(null);
    try {
      const input = fromDraft(draft);
      if (isSelf) delete input.relationship;
      await saveProfile(profile.id, input);
      toast.info('Profile saved.');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <div className="page__head profile-head">
        <Avatar profile={profile} size={64} />
        <div>
          <p className="eyebrow">{RELATIONSHIP_LABEL[profile.relationship]}{age != null ? ` · ${age} years old` : ''}</p>
          <h1>{profile.displayName}</h1>
        </div>
      </div>
      <div className="profile-grid">
        <form className="stack" onSubmit={submit} noValidate>
          <section className="panel">
            <h2>Personal details</h2>
            <div className="form-grid">
              <Field label="Name" error={errors.displayName}>{id => <input id={id} value={draft.displayName} onChange={e => patch({ displayName: e.target.value })} maxLength={80} />}</Field>
              {!isSelf && (
                <Field label="Who they are to you">{id => (
                  <select id={id} value={draft.relationship} onChange={e => patch({ relationship: e.target.value as Relationship })}>
                    {FAMILY.map(r => <option key={r} value={r}>{RELATIONSHIP_LABEL[r]}</option>)}
                  </select>
                )}</Field>
              )}
              <Field label="Date of birth" error={errors.dateOfBirth}>{id => <input id={id} type="date" value={draft.dateOfBirth} max={todayIso()} onChange={e => patch({ dateOfBirth: e.target.value })} />}</Field>
              <Field label="Sex assigned at birth" hint="Some reference ranges differ by sex.">{id => <SexChoice id={id} value={draft.sex} onChange={v => patch({ sex: v })} />}</Field>
              <Field label="Blood type">{id => <BloodTypeSelect id={id} value={draft.bloodType} onChange={v => patch({ bloodType: v })} />}</Field>
            </div>
          </section>

          <BodyMeasurements draft={draft} errors={errors} patch={patch} bmi={bmi} />

          <section className="panel">
            <h2>Health background</h2>
            <p className="note panel__intro">Press Enter after each entry. These notes are for your own reference; LotusPond does not use them to judge results.</p>
            <div className="form-grid form-grid--1">
              <Field label="Conditions">{id => <TagInput id={id} value={draft.conditions} onChange={v => patch({ conditions: v })} placeholder="e.g. Hypothyroidism" />}</Field>
              <Field label="Medications and supplements">{id => <TagInput id={id} value={draft.medications} onChange={v => patch({ medications: v })} placeholder="e.g. Levothyroxine 50 µg" />}</Field>
              <Field label="Allergies">{id => <TagInput id={id} value={draft.allergies} onChange={v => patch({ allergies: v })} placeholder="e.g. Penicillin" />}</Field>
              <Field label="Notes">{id => <textarea id={id} rows={4} value={draft.notes} onChange={e => patch({ notes: e.target.value })} maxLength={5000} placeholder="Anything worth remembering at your next appointment." />}</Field>
            </div>
          </section>

          <div className={`savebar${dirty ? ' is-dirty' : ''}`}>
            <span>{error ? <span className="form-error">{error}</span> : dirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>
            <button type="button" className="btn btn--quiet" disabled={!dirty || busy} onClick={() => { setDraft(toDraft(profile)); setError(null); }}>Discard</button>
            <button className="btn btn--primary" disabled={!dirty || busy || Object.keys(errors).length > 0}>{busy ? 'Saving…' : 'Save changes'}</button>
          </div>
        </form>

        <aside className="stack">
          <RecordsPanel profile={profile} />
          <HomeAreaPanel profile={profile} locked={dirty} />
          <FamilyPanel />
          {!isSelf && <RemovePanel profile={profile} />}
        </aside>
      </div>
    </main>
  );
}

/** Height and weight in the account's measurement system (stored in cm and kg either way). */
function BodyMeasurements({ draft, errors, patch, bmi }: {
  draft: ProfileDraft; errors: ReturnType<typeof checkDraft>; patch: (p: Partial<ProfileDraft>) => void; bmi: number | null;
}) {
  const system = useMeasurementSystem();
  const us = system === 'us';
  return (
    <section className="panel">
      <h2>Body measurements</h2>
      <div className="form-grid form-grid--3">
        <Field label="Height" error={errors.heightCm && (us ? IMPERIAL_ERRORS.height : errors.heightCm)}>
          {id => <HeightInput id={id} system={system} cm={draft.heightCm} onChange={v => patch({ heightCm: v })} />}
        </Field>
        <Field label="Weight" error={errors.weightKg && (us ? IMPERIAL_ERRORS.weight : errors.weightKg)}>
          {id => <WeightInput id={id} system={system} kg={draft.weightKg} onChange={v => patch({ weightKg: v })} />}
        </Field>
        <div className="readout" aria-live="polite">
          <span>Body mass index</span>
          <b>{bmi ?? '—'}</b>
          <small>{bmi ? 'kg/m², from height and weight' : 'Add height and weight'}</small>
        </div>
      </div>
    </section>
  );
}

function RecordsPanel({ profile }: { profile: Profile }) {
  const { measurements, scans, documents, clearAll } = useHealth();
  const { setUploadOpen, setView } = useUI();
  const ds = dates(measurements);
  const exportUrl = backend.exportUrl(profile.id);
  return (
    <section className="panel">
      <h2>Records</h2>
      <div className="tally">
        <div><b>{measurements.length}</b><span>results</span></div>
        <div><b>{scans.length}</b><span>scans</span></div>
        <div><b>{documents.length}</b><span>files</span></div>
      </div>
      <p className="note" style={{ margin: '10px 0 14px' }}>{ds.length ? `From ${ds.length} sample date${ds.length > 1 ? 's' : ''}, latest ${formatDate(ds[ds.length - 1])}.` : 'Nothing uploaded yet.'}</p>
      <div className="tools">
        <button className="btn btn--primary" onClick={() => setUploadOpen(true)}>{Icon.upload} Upload</button>
        <button className="btn" onClick={() => setView('files')}>{Icon.file} Files</button>
        {exportUrl && <a className="btn" href={exportUrl} download>{Icon.download} Export</a>}
      </div>
      {(measurements.length > 0 || documents.length > 0) && (
        <div className="panel__danger">
          <ConfirmButton className="btn btn--quiet btn--danger-text" confirmText="Delete every result, scan and file?" busyText="Deleting…"
            onConfirm={async () => { try { await clearAll(); toast.info('All records deleted.'); } catch (e) { toast.error(errorMessage(e)); } }}>
            Delete all records
          </ConfirmButton>
        </div>
      )}
    </section>
  );
}

function FamilyPanel() {
  const { profiles, activeId, switchProfile } = useSession();
  const setAddProfileOpen = useUI(s => s.setAddProfileOpen);
  return (
    <section className="panel">
      <h2>People on this account</h2>
      <ul className="people">
        {profiles.map(p => (
          <li key={p.id}>
            <Avatar profile={p} size={30} />
            <span><b>{p.displayName}</b><small>{RELATIONSHIP_LABEL[p.relationship]}{ageFrom(p.dateOfBirth) != null ? `, ${ageFrom(p.dateOfBirth)}` : ''}</small></span>
            {p.id === activeId ? <em>Open</em> : <button className="linkish" onClick={() => switchProfile(p.id)}>Open</button>}
          </li>
        ))}
      </ul>
      <button className="btn" onClick={() => setAddProfileOpen(true)}>{Icon.plus} Add a family member</button>
    </section>
  );
}

function RemovePanel({ profile }: { profile: Profile }) {
  const deleteProfile = useSession(s => s.deleteProfile);
  return (
    <section className="panel panel--danger">
      <h2>Remove {profile.displayName}</h2>
      <p className="note" style={{ marginBottom: 12 }}>Deletes this profile with all of its results, scans and files. This cannot be undone.</p>
      <ConfirmButton confirmText="Remove this profile and everything in it?" busyText="Removing…"
        onConfirm={async () => { try { await deleteProfile(profile.id); toast.info(`${profile.displayName} was removed.`); } catch (e) { toast.error(errorMessage(e)); } }}>
        Remove profile
      </ConfirmButton>
    </section>
  );
}
