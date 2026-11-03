// Find a lab: partner labs and public labs, imaging centres, hospitals and clinics near a chosen area,
// on a map and as cards with one-tap directions, calls and booking.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Facility, FacilityKind, FacilitySearchResult } from '../types';
import { ApiError, errorMessage, isPreview } from '../api';
import { FACILITY_KINDS, RADIUS_OPTIONS_KM } from '../../shared/facilities';
import { firstName, useActiveProfile, useSession } from '../state/session';
import { FacilityCard } from '../components/labs/FacilityCard';
import { EmptyState } from '../components/labs/Illustration';
import { LabIcon } from '../components/labs/LabIcon';
import { LocationPicker, RememberArea } from '../components/labs/LocationPicker';
import { KIND, savedArea } from '../components/labs/meta';
import { useLabs, useNearby, usePublicConfig, type KindFilter, type SearchPoint } from '../components/labs/store';
import '../styles/labs.css';

// The map (MapLibre, about 1 MB) loads with this page only, and never in the server-less preview.
const FacilityMap = import.meta.env.VITE_BACKEND === 'browser' ? null : lazy(() => import('../components/labs/FacilityMap'));

const SOURCE_LABEL: Record<SearchPoint['source'], string> = { device: 'Your location', search: 'Searched area', saved: 'Home area' };

export default function Labs() {
  const profile = useActiveProfile();
  const account = useSession(s => s.account);
  const { picked, radiusKm, filter, selectedId, pick, setRadius, setFilter, select } = useLabs();
  const [changing, setChanging] = useState(false);
  const saved = savedArea(profile);
  const point: SearchPoint | null = picked ?? (saved ? { ...saved, source: 'saved' } : null);
  const country = point?.country ?? profile?.country ?? account?.country ?? null;
  const config = usePublicConfig();
  const nearby = useNearby(point, radiusKm, country, !isPreview);
  const data = nearby.status === 'ready' ? nearby.data : null;

  const all: Facility[] = useMemo(() => (data ? [...data.partners, ...data.places] : []), [data]);
  const counts = useMemo(() => {
    const c: Record<KindFilter, number> = { all: all.length, lab: 0, imaging: 0, hospital: 0, clinic: 0 };
    for (const f of all) c[f.kind]++;
    return c;
  }, [all]);
  const shown = useMemo(() => (filter === 'all' ? all : all.filter(f => f.kind === filter)), [all, filter]);

  // Selecting a marker scrolls its card into view.
  const cards = useRef(new Map<string, HTMLElement>());
  const registerCard = useCallback((id: string, el: HTMLElement | null) => {
    if (el) cards.current.set(id, el);
    else cards.current.delete(id);
  }, []);
  useEffect(() => {
    const el = selectedId ? cards.current.get(selectedId) : null;
    el?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [selectedId]);

  const choose = (p: SearchPoint) => { pick(p); setChanging(false); };
  const who = profile ? (profile.relationship === 'self' ? 'you' : firstName(profile)) : 'you';

  return (
    <main className="page labs">
      <header className="labs__head">
        <div>
          <h1>Find a lab</h1>
          <p className="labs__sub">Labs, scans and hospitals near {who}</p>
        </div>
        {point && (
          <div className="lbar">
            <span className="lbar__place">
              <span className="lbar__pin"><LabIcon name={point.source === 'device' ? 'locate' : point.source === 'saved' ? 'home' : 'pin'} /></span>
              <span><small>{SOURCE_LABEL[point.source]}</small><b>{point.label}</b></span>
            </span>
            <button type="button" className="btn btn--quiet" aria-expanded={changing} onClick={() => setChanging(v => !v)}>
              <LabIcon name={changing ? 'close' : 'edit'} />{changing ? 'Close' : 'Change'}
            </button>
            {profile && !changing && <RememberArea profile={profile} point={point} onSaved={() => pick(null)} />}
          </div>
        )}
      </header>

      {point && changing && <div className="labs__picker"><LocationPicker onPick={choose} autoFocus /></div>}

      {!point && (
        <EmptyState variant="find" title="Where should we look?" action={<LocationPicker onPick={choose} variant="hero" />}>
          Share your location or search an area to see labs, imaging centres and hospitals close by.
        </EmptyState>
      )}

      {point && isPreview && (
        <EmptyState variant="preview" title="Nearby search needs the server">
          This preview runs without the LotusPond server, so it cannot look up labs. {profile && saved ? 'Your area is saved here.' : 'You can still set and save your area.'} The full app shows partner labs and public listings near it.
        </EmptyState>
      )}

      {point && !isPreview && (
        <>
          <div className="labs__controls">
            <div className="kchips" role="group" aria-label="Show">
              {(['all', ...FACILITY_KINDS] as KindFilter[]).map(k => (
                <button key={k} type="button" className="kchip" aria-pressed={filter === k} onClick={() => setFilter(k)}
                  style={k === 'all' ? undefined : { '--kind': KIND[k as FacilityKind].color } as CSSProperties}>
                  {k === 'all' ? <LabIcon name="pin" /> : <LabIcon name={k as FacilityKind} />}
                  {k === 'all' ? 'All' : KIND[k as FacilityKind].plural}
                  {data && <span className="kchip__n">{counts[k]}</span>}
                </button>
              ))}
            </div>
            <div className="seg rchips" role="group" aria-label="Distance">
              {RADIUS_OPTIONS_KM.map(r => (
                <button key={r} type="button" aria-pressed={radiusKm === r} onClick={() => setRadius(r)}>{r} km</button>
              ))}
            </div>
          </div>

          <div className="labs__body">
            <div className="labs__map">
              {FacilityMap && config && (
                <Suspense fallback={<div className="fmap fmap--loading" aria-hidden />}>
                  <FacilityMap settings={config.map} center={point} radiusKm={radiusKm} facilities={shown} selectedId={selectedId} onSelect={select} label={point.label} />
                </Suspense>
              )}
              {!config && <div className="fmap fmap--loading" aria-hidden />}
            </div>
            <div className="labs__list">
              <Results status={nearby.status} data={data} error={nearby.status === 'error' ? nearby.error : null} retry={nearby.retry}
                shown={shown} filter={filter} radiusKm={radiusKm} selectedId={selectedId} onSelect={id => select(id === selectedId ? null : id)}
                setRadius={setRadius} setFilter={setFilter} registerCard={registerCard} />
            </div>
          </div>
        </>
      )}
    </main>
  );
}

/** A title and a short line for a failed search. */
function explain(error: unknown): { title: string; text: string } {
  const code = error instanceof ApiError ? error.code : '';
  if (code === 'search_unavailable') return { title: 'Nearby search is unavailable', text: 'The listings service is not answering. Try again in a few minutes.' };
  if (code === 'search_off') return { title: 'Nearby search is off', text: 'This LotusPond server has nearby search turned off.' };
  if (code === 'busy' || code === 'rate_limited') return { title: 'Too many searches', text: errorMessage(error) };
  if (error instanceof ApiError && error.status === 0) return { title: 'Cannot reach LotusPond', text: errorMessage(error) };
  return { title: 'Something went wrong', text: errorMessage(error) };
}

function Results({ status, data, error, retry, shown, filter, radiusKm, selectedId, onSelect, setRadius, setFilter, registerCard }: {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: FacilitySearchResult | null;
  error: unknown;
  retry: () => void;
  shown: Facility[];
  filter: KindFilter;
  radiusKm: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  setRadius: (r: number) => void;
  setFilter: (f: KindFilter) => void;
  registerCard: (id: string, el: HTMLElement | null) => void;
}) {
  if (status === 'loading' || status === 'idle') {
    return <div className="fskel" role="status" aria-label="Searching nearby">{[0, 1, 2].map(i => <div key={i} className="fskel__card"><i /><span><b /><em /><em /></span></div>)}</div>;
  }
  if (status === 'error') {
    const { title, text } = explain(error);
    return (
      <EmptyState variant="offline" title={title} action={<button type="button" className="btn btn--primary" onClick={retry}>Try again</button>}>
        {text}
      </EmptyState>
    );
  }
  if (!data) return null;
  const bigger = RADIUS_OPTIONS_KM.find(r => r > radiusKm);
  if (!shown.length) {
    const anyKind = filter !== 'all' && data.partners.length + data.places.length > 0;
    return (
      <EmptyState variant="empty" title={`Nothing ${filter === 'all' ? '' : `in ${KIND[filter as FacilityKind].plural.toLowerCase()} `}within ${radiusKm} km`}
        action={
          <>
            {bigger && <button type="button" className="btn btn--primary" onClick={() => setRadius(bigger)}>Search {bigger} km</button>}
            {anyKind && <button type="button" className="btn" onClick={() => setFilter('all')}>Show all kinds</button>}
          </>
        }>
        {bigger ? 'Try a wider circle.' : 'Try another area.'}
      </EmptyState>
    );
  }
  const partners = shown.filter(f => f.source === 'partner');
  const places = shown.filter(f => f.source === 'osm');
  const card = (f: Facility) => (
    <FacilityCard key={f.id} f={f} selected={f.id === selectedId} onSelect={onSelect}
      ref={el => registerCard(f.id, el)} />
  );
  return (
    <>
      {data.notice && <p className="lnotice" role="status"><LabIcon name="cloudOff" />{data.notice.message} Partner labs are still shown.</p>}
      {partners.length > 0 && (
        <section className="lgroup lgroup--partners" aria-label="LotusPond partner labs">
          <h2><LabIcon name="star" />LotusPond partners</h2>
          {partners.map(card)}
        </section>
      )}
      {places.length > 0 && (
        <section className="lgroup" aria-label="Nearby places">
          <h2>{places.length} nearby<small> · within {radiusKm} km</small></h2>
          {places.map(card)}
        </section>
      )}
      <p className="lattrib">
        Public listings <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">{data.attribution}</a>.
        {' '}Check hours before you go.
      </p>
    </>
  );
}
