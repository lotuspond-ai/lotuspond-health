// Onboarding step: set a home area for finding labs nearby (optional).
import { useState } from 'react';
import type { Profile } from '../../types';
import { errorMessage } from '../../api';
import { Logo } from '../ui';
import { saveArea } from './area';
import { LabsDrawing } from './Illustration';
import { LabIcon } from './LabIcon';
import { LocationPicker } from './LocationPicker';
import type { SearchPoint } from './store';

export function OnboardingArea({ profile, step, onDone }: { profile: Profile; step: string; onDone: () => void }) {
  const [point, setPoint] = useState<SearchPoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish() {
    if (!point) return;
    setBusy(true);
    setError(null);
    try {
      await saveArea(profile, point);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="onboard">
      <div className="onboard__card oarea">
        <div className="auth__brand auth__brand--ink"><Logo /><b>LotusPond <span>Health</span></b></div>
        <p className="eyebrow">{step}</p>
        <h1>Labs near you</h1>
        <p className="lede">Set a home area to find labs, scans and hospitals close by. It is saved to about 1 km.</p>
        <LabsDrawing variant="find" />
        {point ? (
          <div className="oarea__chosen" role="status">
            <span className="oarea__check"><LabIcon name="check" /></span>
            <span><small>Home area</small><b>{point.label}</b></span>
            <button type="button" className="btn btn--quiet" onClick={() => setPoint(null)}><LabIcon name="edit" />Change</button>
          </div>
        ) : (
          <LocationPicker onPick={setPoint} variant="hero" />
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="onboard__actions">
          <button type="button" className="btn btn--quiet" onClick={onDone}>Skip for now</button>
          <button type="button" className="btn btn--primary" disabled={busy || !point} onClick={() => void finish()}>{busy ? 'Saving…' : 'Continue to your body map'}</button>
        </div>
      </div>
    </div>
  );
}
