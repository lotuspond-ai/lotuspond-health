// Top-bar profile switcher, the "add a family member" dialog, and toast messages.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { confirmationFor, confirmationText } from '../../shared/family';
import type { FamilyConfirmation, Relationship } from '../types';
import { errorMessage } from '../api';
import { RELATIONSHIP_LABEL, useActiveProfile, useSession } from '../state/session';
import { useUI } from '../state/ui';
import { useToasts } from '../state/toast';
import {
  Avatar, Field, SexChoice,
} from './forms';
import { checkDraft, emptyDraft, fromDraft, type ProfileDraft, todayIso } from '../lib/profile';
import { Icon } from './ui';
import '../styles/agents.css';

export function ProfileMenu() {
  const { profiles, activeId, account, switchProfile, signOut } = useSession();
  const active = useActiveProfile();
  const { setView, setAddProfileOpen } = useUI();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', key); };
  }, [open]);

  if (!active) return null;
  const go = (fn: () => void) => { setOpen(false); fn(); };

  return (
    <div className="pmenu" ref={root}>
      <button className="pmenu__trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Avatar profile={active} size={30} />
        <span className="pmenu__name">{active.displayName}</span>
        {Icon.chevron}
      </button>
      {open && (
        <div className="pmenu__panel" role="menu">
          <p className="pmenu__label">Viewing records for</p>
          {profiles.map(p => (
            <button key={p.id} role="menuitemradio" aria-checked={p.id === activeId} className="pmenu__item" onClick={() => go(() => switchProfile(p.id))}>
              <Avatar profile={p} size={28} />
              <span><b>{p.displayName}</b><small>{RELATIONSHIP_LABEL[p.relationship]}</small></span>
              {p.id === activeId && <i className="pmenu__check">{Icon.check}</i>}
            </button>
          ))}
          <button role="menuitem" className="pmenu__item pmenu__item--add" onClick={() => go(() => setAddProfileOpen(true))}>
            <span className="pmenu__icon">{Icon.plus}</span><span><b>Add a family member</b></span>
          </button>
          <hr />
          <button role="menuitem" className="pmenu__row" onClick={() => go(() => setView('profile'))}>{Icon.user} Profile details</button>
          <button role="menuitem" className="pmenu__row" onClick={() => go(() => setView('account'))}>{Icon.key} Account and sign-in</button>
          <button role="menuitem" className="pmenu__row" onClick={() => go(() => void signOut())}>{Icon.out} Sign out</button>
          <p className="pmenu__foot">{account?.email}</p>
        </div>
      )}
    </div>
  );
}

const FAMILY: { v: Relationship; label: string }[] = [
  { v: 'child', label: 'Child' }, { v: 'partner', label: 'Partner' }, { v: 'parent', label: 'Parent' }, { v: 'sibling', label: 'Sibling' }, { v: 'other', label: 'Someone else' },
];

export function AddProfileDialog() {
  const { addProfileOpen, setAddProfileOpen, setView } = useUI();
  const createProfile = useSession(s => s.createProfile);
  const [draft, setDraft] = useState<ProfileDraft>(() => emptyDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  // Which confirmation was ticked: a different one (child ↔ adult) has to be ticked again.
  const [ticked, setTicked] = useState<FamilyConfirmation | null>(null);
  useEffect(() => {
    if (!addProfileOpen) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setAddProfileOpen(false);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [addProfileOpen, setAddProfileOpen]);
  if (!addProfileOpen) return null;

  const errors = checkDraft(draft);
  const patch = (p: Partial<ProfileDraft>) => setDraft({ ...draft, ...p });
  const close = () => { setAddProfileOpen(false); setDraft(emptyDraft()); setError(null); setTouched(false); setBusy(false); setTicked(null); };
  // What the person confirms depends on who they are adding (Terms §4); changing it asks again.
  const confirmation = confirmationFor(draft.relationship, draft.dateOfBirth || null);
  const confirmed = ticked === confirmation;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length || !confirmed) return;
    setBusy(true);
    try {
      await createProfile(fromDraft(draft), confirmation);
      close();
      setView('home');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onClick={close}>
      <form className="dialog dialog--narrow" role="dialog" aria-modal="true" aria-labelledby="ap-title" onClick={e => e.stopPropagation()} onSubmit={submit} noValidate>
        <div className="dialog__head">
          <div><h2 id="ap-title">Add a family member</h2><p className="muted">Their results and scans are kept separately from yours. Switch between people from the menu at the top.</p></div>
          <button type="button" className="btn btn--quiet x" onClick={close} aria-label="Close">{Icon.close}</button>
        </div>
        <div className="form-grid">
          <Field label="Name" error={touched ? errors.displayName : null}>{id => <input id={id} value={draft.displayName} onChange={e => patch({ displayName: e.target.value })} maxLength={80} autoFocus />}</Field>
          <Field label="Who are they to you?">{id => (
            <select id={id} value={draft.relationship} onChange={e => patch({ relationship: e.target.value as Relationship })}>
              {FAMILY.map(f => <option key={f.v} value={f.v}>{f.label}</option>)}
            </select>
          )}</Field>
          <Field label="Date of birth" error={errors.dateOfBirth}>{id => <input id={id} type="date" value={draft.dateOfBirth} max={todayIso()} onChange={e => patch({ dateOfBirth: e.target.value })} />}</Field>
          <Field label="Sex assigned at birth" wide>{id => <SexChoice id={id} value={draft.sex} onChange={v => patch({ sex: v })} />}</Field>
        </div>
        <label className="confirm-check">
          <input type="checkbox" checked={confirmed} onChange={e => setTicked(e.target.checked ? confirmation : null)} />
          <span>{confirmationText(confirmation, draft.displayName)}</span>
        </label>
        {touched && !confirmed && <p className="form-error" role="alert">Tick the confirmation to add this person.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button className="btn btn--primary" disabled={busy}>{busy ? 'Adding…' : 'Add and open their records'}</button>
        </div>
      </form>
    </div>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast--${t.tone}`}>
          <span>{t.text}</span>
          <button className="btn btn--quiet" onClick={() => dismiss(t.id)} aria-label="Dismiss">{Icon.close}</button>
        </div>
      ))}
    </div>
  );
}
