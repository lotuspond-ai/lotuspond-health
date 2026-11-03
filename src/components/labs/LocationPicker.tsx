// Choose where to look: this device's location, or an area or postcode typed with suggestions.
// The device position is used for the search only; saving an area stores it rounded to about 1 km.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { GeoCandidate, Profile } from '../../types';
import { backend, errorMessage } from '../../api';
import { firstName } from '../../state/session';
import { toast } from '../../state/toast';
import { LabIcon } from './LabIcon';
import { sameArea, saveArea } from './area';
import { savedArea } from './meta';
import type { SearchPoint } from './store';
import '../../styles/labs.css';

function geoErrorMessage(err: GeolocationPositionError | null): string {
  if (!err) return 'This browser cannot share its location here. Search for your area instead.';
  if (err.code === err.PERMISSION_DENIED) return 'Location is blocked for this site. Allow it in your browser settings, or search for your area.';
  if (err.code === err.TIMEOUT) return 'Finding your location took too long. Try again, or search for your area.';
  return 'Your device could not find its location. Search for your area instead.';
}

export function LocationPicker({ onPick, variant = 'inline', autoFocus = false, label = 'Area or postcode' }: {
  onPick: (p: SearchPoint) => void;
  variant?: 'hero' | 'inline';
  autoFocus?: boolean;
  label?: string;
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ q: string; items: GeoCandidate[]; error?: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [locating, setLocating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const inputId = useId();
  const listId = useId();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      backend.searchPlaces(q).then(
        items => { if (live) setFound({ q, items }); },
        e => { if (live) setFound({ q, items: [], error: errorMessage(e) }); },
      );
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [q]);

  const current = found?.q === q ? found : null;
  const items = q.length >= 2 ? current?.items ?? [] : [];
  const searching = q.length >= 2 && !current;
  const showList = open && q.length >= 2;

  function choose(c: GeoCandidate) {
    onPick({ lat: c.lat, lon: c.lon, label: c.label, country: c.country, postalCode: c.postalCode, source: 'search' });
    setQuery('');
    setOpen(false);
    setProblem(null);
  }

  function locate() {
    setProblem(null);
    if (!('geolocation' in navigator) || !window.isSecureContext) { setProblem(geoErrorMessage(null)); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async pos => {
        const { latitude: lat, longitude: lon } = pos.coords;
        let label = 'Near you', country: string | null = null, postalCode: string | null = null;
        try {
          const r = await backend.reversePlace(lat, lon);
          ({ label, country, postalCode } = r);
        } catch { /* keep the generic label; the search still works */ }
        if (!mounted.current) return;
        setLocating(false);
        onPick({ lat, lon, label, country, postalCode, source: 'device' });
      },
      err => { if (mounted.current) { setLocating(false); setProblem(geoErrorMessage(err)); } },
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 10 * 60_000 },
    );
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); setOpen(true); setActive(a => (a + 1) % items.length); }
    else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); setActive(a => (a - 1 + items.length) % items.length); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[active]) choose(items[active]); }
    else if (e.key === 'Escape') { setOpen(false); }
  }

  return (
    <div className={`lpick lpick--${variant}`}>
      <button type="button" className={`lpick__locate${variant === 'hero' ? ' btn btn--primary' : ' btn'}`} onClick={locate} disabled={locating}>
        <LabIcon name={locating ? 'spinner' : 'locate'} className={locating ? 'spin' : undefined} />
        {locating ? 'Finding you…' : 'Use my location'}
      </button>
      {variant === 'hero' && <span className="lpick__or" aria-hidden>or</span>}
      <div className="lpick__search">
        <label htmlFor={inputId} className="sr-only">{label}</label>
        <div className="lpick__field">
          <LabIcon name="search" className="lpick__glass" />
          <input id={inputId} type="search" value={query} placeholder={variant === 'hero' ? 'Search an area or postcode' : 'Area or postcode'}
            autoComplete="off" autoFocus={autoFocus} spellCheck={false} maxLength={120}
            role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={showList && items[active] ? `${listId}-${active}` : undefined}
            onChange={e => { setQuery(e.target.value); setOpen(true); setActive(0); }}
            onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKey} />
        </div>
        {showList && (
          <ul className="lpick__list" id={listId} role="listbox" aria-label="Places">
            {searching && <li className="lpick__note" role="presentation"><LabIcon name="spinner" className="spin" /> Searching…</li>}
            {current?.error && <li className="lpick__note lpick__note--error" role="presentation">{current.error}</li>}
            {current && !current.error && !items.length && <li className="lpick__note" role="presentation">No places match. Try a postcode or a nearby area.</li>}
            {items.map((c, i) => (
              <li key={`${c.label}-${c.lat}-${c.lon}`} id={`${listId}-${i}`} role="option" aria-selected={i === active}
                className={`lpick__option${i === active ? ' is-active' : ''}`}
                onMouseDown={e => { e.preventDefault(); choose(c); }} onMouseEnter={() => setActive(i)}>
                <LabIcon name="pin" />
                <span><b>{c.label}</b>{c.detail && <small>{c.detail}</small>}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {problem && <p className="lpick__problem" role="alert">{problem}</p>}
    </div>
  );
}

/** "Remember this area for Asha": shown when the searched point is not the saved home area. */
export function RememberArea({ profile, point, onSaved }: { profile: Profile; point: SearchPoint; onSaved?: () => void }) {
  const [busy, setBusy] = useState(false);
  if (sameArea(point, savedArea(profile))) {
    return <span className="lbar__saved"><LabIcon name="home" /> {profile.relationship === 'self' ? 'Your home area' : `${firstName(profile)}’s home area`}</span>;
  }
  return (
    <button type="button" className="btn lbar__remember" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        await saveArea(profile, point);
        toast.info(`Saved as ${profile.relationship === 'self' ? 'your' : `${firstName(profile)}’s`} home area.`);
        onSaved?.();
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy(false);
      }
    }}>
      <LabIcon name="home" /> {busy ? 'Saving…' : `Remember this area for ${firstName(profile)}`}
    </button>
  );
}
