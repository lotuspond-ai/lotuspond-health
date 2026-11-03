// "Home area" on the profile page: where to look for labs for this person. Saved to about 1 km.
import { useState } from 'react';
import type { Profile } from '../../types';
import { errorMessage } from '../../api';
import { countryName } from '../../../shared/regions';
import { firstName } from '../../state/session';
import { toast } from '../../state/toast';
import { useUI } from '../../state/ui';
import { saveArea } from './area';
import { LabIcon } from './LabIcon';
import { LocationPicker } from './LocationPicker';
import { savedArea } from './meta';
import type { SearchPoint } from './store';

/** `locked` while the rest of the profile form has unsaved changes (saving here reloads the form). */
export function HomeAreaPanel({ profile, locked = false }: { profile: Profile; locked?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const setView = useUI(s => s.setView);
  const area = savedArea(profile);
  const who = profile.relationship === 'self' ? 'you' : firstName(profile);

  async function save(p: SearchPoint | null) {
    setBusy(true);
    try {
      await saveArea(profile, p);
      toast.info(p ? 'Home area saved.' : 'Home area removed.');
      setEditing(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel harea" aria-labelledby="harea-title">
      <h2 id="harea-title">Home area</h2>
      {!editing && (area ? (
        <div className="harea__place">
          <span className="harea__pin"><LabIcon name="home" /></span>
          <span>
            <b>{area.label}</b>
            <small>{[area.postalCode, area.country ? countryName(area.country) : null].filter(Boolean).join(' · ') || 'Saved to about 1 km'}</small>
          </span>
        </div>
      ) : (
        <p className="note harea__empty"><LabIcon name="pin" />Set an area to find labs near {who}.</p>
      ))}
      {editing && <LocationPicker onPick={p => void save(p)} autoFocus />}
      {locked && !editing && <p className="note">Save or discard the changes above first.</p>}
      <div className="tools harea__tools">
        {editing ? (
          <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
        ) : (
          <>
            <button type="button" className="btn" disabled={locked || busy} onClick={() => setEditing(true)}>
              <LabIcon name={area ? 'edit' : 'pin'} />{area ? 'Change' : 'Set area'}
            </button>
            {area && <button type="button" className="btn" onClick={() => setView('labs')}><LabIcon name="lab" />Find a lab</button>}
            {area && <button type="button" className="btn btn--quiet" disabled={locked || busy} onClick={() => void save(null)}>Remove</button>}
          </>
        )}
      </div>
    </section>
  );
}
