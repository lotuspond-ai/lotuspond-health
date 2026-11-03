import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useHealth } from '../lib/store';
import { SYSTEM_LABELS } from '../lib/catalog';
import { useUI, type SectionAxis } from '../state/ui';
import { ORGANS, ORGAN_BY_ID } from '../anatomy/organs';
import { buildSeries, formatDate, seriesForOrgan, systemCounts, STATUS_WORD, type Series } from '../lib/derive';
import { Icon, RangeBar, Sparkline } from '../components/ui';
import type { OrganId, SystemId } from '../types';
import { errorMessage, isPreview } from '../api';
import { firstName, possessive, useActiveProfile } from '../state/session';
import { toast } from '../state/toast';
import { findLegacyData, legacyAsResult, markLegacyHandled } from '../lib/legacy';

const Stage = lazy(() => import('../three/Stage'));

function useSeries() {
  const measurements = useHealth(s => s.measurements);
  return useMemo(() => buildSeries(measurements), [measurements]);
}

function organState(series: Series[], organ: OrganId) {
  const list = seriesForOrgan(series, organ);
  if (!list.length) return '';
  return list.some(s => s.latest.status === 'high' || s.latest.status === 'low') ? 'out' : 'ok';
}

function IndexPanel({ series }: { series: Series[] }) {
  const activeSystem = useHealth(s => s.activeSystem), setActiveSystem = useHealth(s => s.setActiveSystem);
  const selected = useHealth(s => s.selectedOrgan), selectOrgan = useHealth(s => s.selectOrgan);
  const { hovered, setHovered } = useUI();
  const counts = systemCounts(series);
  const systems = (Object.keys(SYSTEM_LABELS) as SystemId[]).filter(s => counts[s]);
  return (
    <nav className="index" aria-label="Body systems and organs">
      <h3>Body systems</h3>
      {systems.length === 0 && <p className="note" style={{ padding: '0 10px' }}>Systems appear here once you add results.</p>}
      {systems.map(s => {
        const c = counts[s]!;
        return (
          <button key={s} className="sys" aria-pressed={activeSystem === s} onClick={() => setActiveSystem(activeSystem === s ? null : s)}>
            <span className="name">{SYSTEM_LABELS[s]}</span>
            <span className="count">
              {c.high > 0 && <span className="flag" title={`${c.high} above range`}>{c.high}↑</span>}
              {c.low > 0 && <span className="flag flag--low" title={`${c.low} below range`}>{c.low}↓</span>}
              {c.total}
            </span>
          </button>
        );
      })}
      <div className="organs">
        <h3>Organs</h3>
        {ORGANS.filter(o => o.id !== 'skin').map(o => (
          <button key={o.id} className={`organ-link${hovered === o.id ? ' is-hot' : ''}`} aria-current={selected === o.id}
            onClick={() => selectOrgan(selected === o.id ? null : o.id)} onMouseEnter={() => setHovered(o.id)} onMouseLeave={() => setHovered(null)}>
            <i className={organState(series, o.id)} /><span>{o.name}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

function StageOverlay() {
  const selected = useHealth(s => s.selectedOrgan), selectOrgan = useHealth(s => s.selectOrgan);
  const { layers, toggleLayer, quality, setQuality } = useUI();
  const organ = selected ? ORGAN_BY_ID[selected] : null;
  const profile = useActiveProfile();
  return (
    <>
      <div className="stage__title">
        <h2>{organ ? organ.name : `${possessive(profile)} body, mapped`}</h2>
        <p>{organ ? 'Drag to turn, scroll to move closer, and hover a point to read about it.' : 'Click an organ to open it. Dots show where your results relate.'}</p>
      </div>
      <div className="stage__tools" role="group" aria-label="Model layers">
        {!organ && <button className="chip" aria-pressed={layers.skin} onClick={() => toggleLayer('skin')}>Skin</button>}
        {(!organ || organ.id === 'marrow') && <button className="chip" aria-pressed={layers.skeleton} onClick={() => toggleLayer('skeleton')}>Skeleton</button>}
        <button className="chip" aria-pressed={layers.labels} onClick={() => toggleLayer('labels')}>Labels</button>
        <button className="chip" aria-pressed={quality === 'high'} onClick={() => setQuality(quality === 'high' ? 'fast' : 'high')} title="Soft shadows and water reflections">Studio light</button>
      </div>
      {organ ? (
        <button className="btn stage__back" onClick={() => selectOrgan(null)}>{Icon.back} Whole body</button>
      ) : (
        <div className="stage__legend" aria-hidden>
          <span><i style={{ background: '#5fbf95' }} />All in range</span>
          <span><i style={{ background: '#e9b949' }} />Some outside range</span>
          <span><i style={{ background: '#7f9b98' }} />No results yet</span>
        </div>
      )}
      <div className="stage__hint">Double-click empty water to reset</div>
    </>
  );
}

function MarkerRow({ s }: { s: Series }) {
  const selectMarker = useHealth(st => st.selectMarker);
  const m = s.latest;
  return (
    <button className="mrow" onClick={() => selectMarker(s.key)}>
      <span className="mrow__name">{s.name}</span>
      <span className="mrow__val">{m.valueText}<small>{m.unit}</small></span>
      <span className="mrow__meta"><span className={`st-${m.status}`}>{STATUS_WORD[m.status]}</span>, {formatDate(m.date)} {s.points.length > 1 && <Sparkline points={s.points} />}</span>
      <RangeBar m={m} />
    </button>
  );
}

type Legacy = Awaited<ReturnType<typeof findLegacyData>>;

/** Offer to bring in results saved by the earlier, browser-only version. */
function LegacyImport() {
  const addResult = useHealth(s => s.addResult);
  const profile = useActiveProfile();
  const [legacy, setLegacy] = useState<Legacy>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let alive = true; void findLegacyData().then(d => { if (alive) setLegacy(d); }); return () => { alive = false; }; }, []);
  if (!legacy) return null;
  const n = legacy.measurements.length, k = legacy.scans.length;
  return (
    <div className="callout legacy">
      <p><b>Results from the earlier version of LotusPond</b></p>
      <p className="note">This browser holds {n} result{n === 1 ? '' : 's'}{k ? ` and ${k} scan${k === 1 ? '' : 's'}` : ''} saved before accounts existed. Import them into {profile?.relationship === 'self' ? 'your' : `${firstName(profile)}’s`} records?</p>
      <div className="tools">
        <button className="btn btn--primary" disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            const done = await addResult(await legacyAsResult(legacy), []);
            await markLegacyHandled();
            setLegacy(null);
            toast.info(`Imported ${done.measurements} results${done.scans ? ` and ${done.scans} scans` : ''}.`);
          } catch (e) { toast.error(errorMessage(e)); setBusy(false); }
        }}>{busy ? 'Importing…' : 'Import'}</button>
        <button className="btn btn--quiet" disabled={busy} onClick={() => { void markLegacyHandled(); setLegacy(null); }}>Not now</button>
      </div>
    </div>
  );
}

function Welcome() {
  const loadSample = useHealth(s => s.loadSample);
  const setUploadOpen = useUI(s => s.setUploadOpen);
  const profile = useActiveProfile();
  const [busy, setBusy] = useState(false);
  const self = profile?.relationship !== 'self' ? `${firstName(profile)}’s` : 'your';
  return (
    <div className="welcome">
      <LegacyImport />
      <h2>{profile?.relationship === 'self' ? 'See your results where they happen' : `Start ${self} record`}</h2>
      <p className="lede">Add a lab report or a scan and LotusPond places each result on the organ it relates to, so you can explore {profile?.relationship === 'self' ? 'your body' : `${self} health`} one system at a time.</p>
      <ol>
        <li>Upload PDF or CSV lab reports, or photos and DICOM files of scans.</li>
        <li>Check what was read from each file and fix anything that looks wrong.</li>
        <li>Open an organ to see its results, trends and anatomy up close.</li>
      </ol>
      <div className="actions">
        <button className="btn btn--primary" onClick={() => setUploadOpen(true)}>{Icon.upload} Upload results</button>
        <button className="btn" disabled={busy} onClick={async () => {
          setBusy(true);
          try { await loadSample(); toast.info('Sample results added. Delete them any time from the profile page.'); }
          catch (e) { toast.error(errorMessage(e)); }
          finally { setBusy(false); }
        }}>{busy ? 'Adding sample…' : 'Explore with sample data'}</button>
      </div>
      <p className="note" style={{ marginTop: 18 }}>{isPreview
        ? 'Files are read on this device and saved in this browser only. LotusPond explains results; it does not diagnose.'
        : 'Files are read on this device and saved to your account with their originals. LotusPond explains results; it does not diagnose.'}</p>
    </div>
  );
}

function Overview({ series }: { series: Series[] }) {
  const out = series.filter(s => s.latest.status === 'high' || s.latest.status === 'low');
  const scans = useHealth(s => s.scans);
  const dates = [...new Set(series.flatMap(s => s.points.map(p => p.date).filter(Boolean) as string[]))].sort();
  return (
    <>
      <div className="section">
        <h2>Overview</h2>
        <p className="lede">{dates.length ? `Results from ${dates.length} sample date${dates.length > 1 ? 's' : ''}, latest ${formatDate(dates[dates.length - 1])}.` : 'Results without dates.'}</p>
      </div>
      <div className="section tally">
        <div><b>{series.length}</b><span>markers tracked</span></div>
        <div><b>{out.length}</b><span>outside range</span></div>
        <div><b>{scans.length}</b><span>scans</span></div>
      </div>
      <div className="section">
        <h3>Worth a closer look <small>latest values</small></h3>
        {out.length ? out.map(s => <MarkerRow key={s.key} s={s} />) : <p className="note">Every latest result is within its range.</p>}
      </div>
      <div className="section"><p className="note">Ranges come from your report when it lists one; otherwise a typical adult range is used and marked as such. Discuss results with a clinician before acting on them.</p></div>
    </>
  );
}

function SectionControls() {
  const { xray, setXray, section, setSection } = useUI();
  const axes: { id: SectionAxis; label: string }[] = [{ id: 'coronal', label: 'Front' }, { id: 'sagittal', label: 'Side' }, { id: 'transverse', label: 'Top' }];
  return (
    <div className="section">
      <h3>Look inside</h3>
      <div className="tools">
        <button className="toggle" aria-pressed={xray} onClick={() => setXray(!xray)}><i />X-ray</button>
        <button className="toggle" aria-pressed={section.on} onClick={() => setSection({ on: !section.on })}><i />Cross-section</button>
        {section.on && (
          <div className="seg" role="group" aria-label="Cutting plane">
            {axes.map(a => <button key={a.id} aria-pressed={section.axis === a.id} onClick={() => setSection({ axis: a.id })}>{a.label}</button>)}
          </div>
        )}
      </div>
      {section.on && (
        <label style={{ display: 'block', marginTop: 12 }}>
          <span className="note">Cut depth</span>
          <input className="slider" type="range" min={0} max={0.95} step={0.01} value={section.depth} onChange={e => setSection({ depth: +e.target.value })} />
        </label>
      )}
    </div>
  );
}

function OrganPanel({ organ, series }: { organ: OrganId; series: Series[] }) {
  const o = ORGAN_BY_ID[organ];
  const list = seriesForOrgan(series, organ);
  const scans = useHealth(s => s.scans).filter(s => s.organ === organ);
  const setScanOpen = useUI(s => s.setScanOpen);
  return (
    <>
      <div className="section">
        <h2>{o.name}</h2>
        <p className="lede">{o.summary}</p>
      </div>
      {o.facts.length > 0 && <div className="section"><dl className="facts">{o.facts.map(f => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl></div>}
      <SectionControls />
      <div className="section">
        <h3>Related results <small>{list.length ? `${list.length} markers` : ''}</small></h3>
        {list.length ? list.map(s => <MarkerRow key={s.key} s={s} />) : <p className="note">None of your uploaded results relate to this organ yet.</p>}
      </div>
      <div className="section">
        <h3>Scans <small>{scans.length || ''}</small></h3>
        {scans.length ? (
          <div className="thumbs">{scans.map(s => <button key={s.id} className="thumb" onClick={() => setScanOpen(s.id)}><img src={s.thumbDataUrl} alt={s.fileName} /><span>{s.modality ?? 'Scan'}</span></button>)}</div>
        ) : <p className="note">Attach a scan of this area from the Scans page or while uploading.</p>}
      </div>
      <div className="section">
        <h3>Anatomy in this view</h3>
        {o.landmarks.map(l => <p key={l.name} style={{ margin: '0 0 8px' }}><b style={{ fontWeight: 600 }}>{l.name}.</b> <span className="muted">{l.note}</span></p>)}
      </div>
    </>
  );
}

export default function BodyMap({ hidden }: { hidden?: boolean }) {
  const series = useSeries();
  const selected = useHealth(s => s.selectedOrgan);
  const loading = useHealth(s => s.loading);
  return (
    <main className="bodymap" hidden={hidden}>
      <IndexPanel series={series} />
      <section className="stage" aria-label="3D body model">
        <Suspense fallback={<div className="stage__title"><p>Loading the 3D model…</p></div>}><Stage /></Suspense>
        <StageOverlay />
      </section>
      <aside className="context" aria-live="polite">
        {loading ? <p className="note loading-note" role="status">Loading records…</p>
          : selected ? <OrganPanel organ={selected} series={series} /> : series.length ? <Overview series={series} /> : <Welcome />}
      </aside>
    </main>
  );
}
