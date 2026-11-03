// Form building blocks shared by sign-in, profile and account screens.
import { useId, useState, type ReactNode } from 'react';
import type { BloodType, Profile, Sex } from '../types';
import { initials } from '../lib/profile';
import { BLOOD_TYPES } from '../../shared/constants';
import { Icon } from './ui';

export function Field({ label, hint, error, children, wide }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode; wide?: boolean }) {
  const id = useId();
  return (
    <div className={`field${wide ? ' field--wide' : ''}${error ? ' has-error' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {error ? <p className="field__error" role="alert">{error}</p> : hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  );
}

/** A list of short entries (conditions, medications, allergies) typed one at a time. */
export function TagInput({ id, value, onChange, placeholder }: { id: string; value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [text, setText] = useState('');
  const add = () => {
    const t = text.trim();
    if (t && !value.some(v => v.toLowerCase() === t.toLowerCase())) onChange([...value, t.slice(0, 120)]);
    setText('');
  };
  return (
    <div className="tags">
      {value.map(v => (
        <span key={v} className="tag">{v}<button type="button" onClick={() => onChange(value.filter(x => x !== v))} aria-label={`Remove ${v}`}>{Icon.close}</button></span>
      ))}
      <input id={id} value={text} placeholder={value.length ? 'Add another' : placeholder}
        onChange={e => setText(e.target.value)} onBlur={add}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
          else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
        }} />
    </div>
  );
}

/** A destructive action that asks for confirmation in place (the hosted preview blocks window.confirm). */
export function ConfirmButton({ children, confirmText, onConfirm, busyText = 'Working…', className = 'btn btn--danger' }: {
  children: ReactNode; confirmText: string; onConfirm: () => Promise<void> | void; busyText?: string; className?: string;
}) {
  const [stage, setStage] = useState<'idle' | 'ask' | 'busy'>('idle');
  if (stage === 'idle') return <button type="button" className={className} onClick={() => setStage('ask')}>{children}</button>;
  return (
    <span className="confirm" role="group" aria-label="Confirm">
      <span>{confirmText}</span>
      <button type="button" className="btn btn--danger" disabled={stage === 'busy'} autoFocus
        onClick={async () => { setStage('busy'); try { await onConfirm(); } finally { setStage('idle'); } }}>
        {stage === 'busy' ? busyText : 'Yes, continue'}
      </button>
      <button type="button" className="btn btn--quiet" disabled={stage === 'busy'} onClick={() => setStage('idle')}>Cancel</button>
    </span>
  );
}

/* ---------------- avatar ---------------- */

const TONES = ['lotus', 'lily', 'dusk', 'pollen', 'reed'] as const;

export function Avatar({ profile, size = 32 }: { profile: Pick<Profile, 'id' | 'displayName'>; size?: number }) {
  let h = 0;
  for (const c of profile.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const tone = TONES[h % TONES.length];
  return <span className={`avatar avatar--${tone}`} style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden>{initials(profile.displayName)}</span>;
}

export function SexChoice({ id, value, onChange }: { id: string; value: Sex | ''; onChange: (v: Sex | '') => void }) {
  const options: { v: Sex | ''; label: string }[] = [{ v: 'female', label: 'Female' }, { v: 'male', label: 'Male' }, { v: 'intersex', label: 'Intersex' }, { v: '', label: 'Not set' }];
  return (
    <div className="seg seg--form" role="radiogroup" id={id}>
      {options.map(o => <button key={o.label} type="button" role="radio" aria-checked={value === o.v} aria-pressed={value === o.v} onClick={() => onChange(o.v)}>{o.label}</button>)}
    </div>
  );
}

export function BloodTypeSelect({ id, value, onChange }: { id: string; value: BloodType | ''; onChange: (v: BloodType | '') => void }) {
  return (
    <select id={id} value={value} onChange={e => onChange(e.target.value as BloodType | '')}>
      <option value="">Not known</option>
      {BLOOD_TYPES.map(b => <option key={b} value={b}>{b}</option>)}
    </select>
  );
}
