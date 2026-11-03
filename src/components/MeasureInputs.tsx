// Height and weight inputs in the account's measurement system. Values in and out are draft strings in cm and kg.
import { useState } from 'react';
import { cmToFeetInches, feetInchesToCm, kgToPounds, poundsToKg } from '../lib/measures';
import '../styles/compliance.css';

type System = 'metric' | 'us';

/** Keeps the person's own typing while it converts, and re-reads the value when it changes from outside (Discard). */
function useMirror<T>(value: string, derive: (v: string) => T): [T, (next: T, sent: string) => void] {
  const [local, setLocal] = useState(() => derive(value));
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setLocal(derive(value));
  }
  return [local, (next, sent) => { setLocal(next); setSeen(sent); }];
}

export function HeightInput({ id, cm, onChange, system }: { id: string; cm: string; onChange: (cm: string) => void; system: System }) {
  const [ftIn, setFtIn] = useMirror(cm, cmToFeetInches);
  if (system === 'metric') {
    return <div className="unit"><input id={id} inputMode="decimal" value={cm} onChange={e => onChange(e.target.value)} /><span>cm</span></div>;
  }
  const update = (next: { feet: string; inches: string }) => {
    const sent = feetInchesToCm(next.feet, next.inches);
    setFtIn(next, sent);
    onChange(sent);
  };
  return (
    <div className="unit-pair" role="group" aria-label="Height">
      <div className="unit"><input id={id} inputMode="numeric" aria-label="Height, feet" value={ftIn.feet} onChange={e => update({ ...ftIn, feet: e.target.value })} /><span>ft</span></div>
      <div className="unit"><input inputMode="decimal" aria-label="Height, inches" value={ftIn.inches} onChange={e => update({ ...ftIn, inches: e.target.value })} /><span>in</span></div>
    </div>
  );
}

export function WeightInput({ id, kg, onChange, system }: { id: string; kg: string; onChange: (kg: string) => void; system: System }) {
  const [lb, setLb] = useMirror(kg, kgToPounds);
  if (system === 'metric') {
    return <div className="unit"><input id={id} inputMode="decimal" value={kg} onChange={e => onChange(e.target.value)} /><span>kg</span></div>;
  }
  return (
    <div className="unit">
      <input id={id} inputMode="decimal" value={lb} onChange={e => { const sent = poundsToKg(e.target.value); setLb(e.target.value, sent); onChange(sent); }} />
      <span>lb</span>
    </div>
  );
}
