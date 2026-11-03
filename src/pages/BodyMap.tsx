import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useHealth } from '../lib/store';
import { SYSTEM_LABELS } from '../lib/catalog';
import { useUI, type SectionAxis } from '../state/ui';
import { ORGANS, ORGAN_BY_ID } from '../anatomy/organs';
import { buildSeries, formatDate, seriesForOrgan, systemCounts, STATUS_WORD, type Series } from '../lib/derive';
import { Icon, RangeBar, Sparkline } from '../components/ui';
import { Sheet, type Snap } from '../components/Sheet';
import { COMPACT, useMedia } from '../lib/useMedia';
import type { OrganId, SystemId } from '../types';

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

function SystemButtons({ series }: { series: Series[] }) {
  const activeSystem = useHealth(s => s.activeSystem), setActiveSystem = useHealth(s => s.setActiveSystem);
  const counts = systemCounts(series);
  const systems = (Object.keys(SYSTEM_LABELS) as SystemId[]).filter(s => counts[s]);
  return (
    <>
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
    </>
  );
}

function OrganButtons({ series }: { series: Series[] }) {
  const selected = useHealth(s => s.selectedOrgan), selectOrgan = useHealth(s => s.selectOrgan);
  const { hovered, setHovered } = useUI();
  return (
    <>
      {ORGANS.filter(o => o.id !== 'skin').map(o => (
        <button key={o.id} className={`organ-link${hovered === o.id ? ' is-hot' : ''}`} aria-current={selected === o.id}
          onClick={() => selectOrgan(selected === o.id ? null : o.id)} onMouseEnter={() => setHovered(o.id)} onMouseLeave={() => setHovered(null)}>
          <i className={organState(series, o.id)} /><span>{o.name}</span>
        </button>
      ))}
    </>
  );
}

function IndexPanel({ series }: { series: Series[] }) {
  return (
    <nav className="index" aria-label="Body systems and organs">
      <h3>Body systems</h3>
      <SystemButtons series={series} />
      <div className="organs">
        <h3>Organs</h3>
        <OrganButtons series={series} />
      </div>
    </nav>
  );
}

function Legend() {
  return (
    <div className="stage__legend" aria-hidden>
      <span><i style={{ background: '#5fbf95' }} />All in range</span>
      <span><i style={{ background: '#e9b949' }} />Some outside range</span>
      <span><i style={{ background: '#7f9b98' }} />No results yet</span>
    </div>
  );
}

function StageOverlay({ compact }: { compact: boolean }) {
  const selected = useHealth(s => s.selectedOrgan), selectOrgan = useHealth(s => s.selectOrgan);
  const { layers, toggleLayer, quality, setQuality } = useUI();
  const organ = selected ? ORGAN_BY_ID[selected] : null;
  if (compact) {
    return (
      <>
        {organ && <button className="chip chip--solid stage__back" onClick={() => selectOrgan(null)}>{Icon.back} Whole body</button>}
        <div className="stage__tools" role="group" aria-label="Model layers">
          {!organ && <button className="chip" aria-pressed={layers.skin} onClick={() => toggleLayer('skin')}>Skin</button>}
          {(!organ || organ.id === 'marrow') && <button className="chip" aria-pressed={layers.skeleton} onClick={() => toggleLayer('skeleton')}>Skeleton</button>}
          <button className="chip" aria-pressed={layers.labels} onClick={() => toggleLayer('labels')}>Labels</button>
          <button className="chip" aria-pressed={quality === 'high'} onClick={() => setQuality(quality === 'high' ? 'fast' : 'high')}>Studio light</button>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="stage__title">
        <h2>{organ ? organ.name : 'Your body, mapped'}</h2>
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
      ) : <Legend />}
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

function Welcome() {
  const loadSample = useHealth(s => s.loadSample);
  const setUploadOpen = useUI(s => s.setUploadOpen);
  return (
    <div className="welcome">
      <h2>See your results where they happen</h2>
      <p className="lede">Add a lab report or a scan and LotusPond places each result on the organ it relates to, so you can explore your body one system at a time.</p>
      <ol>
        <li>Upload PDF or CSV lab reports, or photos and DICOM files of scans.</li>
        <li>Check what was read from each file and fix anything that looks wrong.</li>
        <li>Open an organ to see its results, trends and anatomy up close.</li>
      </ol>
      <div className="actions">
        <button className="btn btn--primary" onClick={() => setUploadOpen(true)}>{Icon.upload} Upload results</button>
        <button className="btn" onClick={loadSample}>Explore with sample data</button>
      </div>
      <p className="note" style={{ marginTop: 18 }}>Files are read on this device and stay in this browser. LotusPond explains results; it does not diagnose.</p>
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

function OrganPanel({ organ, series, compact }: { organ: OrganId; series: Series[]; compact?: boolean }) {
  const o = ORGAN_BY_ID[organ];
  const list = seriesForOrgan(series, organ);
  const scans = useHealth(s => s.scans).filter(s => s.organ === organ);
  const setScanOpen = useUI(s => s.setScanOpen);
  return (
    <>
      <div className="section">
        {!compact && <h2>{o.name}</h2>}
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

/** Phone layout: the organ / overview panel as a bottom sheet over the 3D stage. */
function BodySheet({ series }: { series: Series[] }) {
  const selected = useHealth(s => s.selectedOrgan), selectOrgan = useHealth(s => s.selectOrgan);
  const hydrated = useHealth(s => s.hydrated);
  const setStageInset = useUI(s => s.setStageInset);
  const hasData = series.length > 0;
  const [snap, setSnap] = useState<Snap>(() => (selected ? 'half' : hydrated && hasData ? 'peek' : 'half'));
  // Open to half when an organ is chosen, fold down when going back to the whole body,
  // and start folded once saved results have loaded (half-open with the welcome text otherwise).
  const [seen, setSeen] = useState({ selected, ready: hydrated });
  if (seen.selected !== selected || seen.ready !== hydrated) {
    setSeen({ selected, ready: hydrated });
    if (seen.selected !== selected) setSnap(selected ? 'half' : 'peek');
    else if (hydrated) setSnap(hasData ? 'peek' : 'half');
  }
  const onCover = useCallback((px: number) => setStageInset(px), [setStageInset]);
  useEffect(() => () => setStageInset(0), [setStageInset]); // back to the full stage when the sheet goes away

  const organ = selected ? ORGAN_BY_ID[selected] : null;
  const list = selected ? seriesForOrgan(series, selected) : [];
  const outside = (l: Series[]) => l.filter(s => s.latest.status === 'high' || s.latest.status === 'low').length;
  const sub = organ
    ? (list.length ? `${list.length} related result${list.length > 1 ? 's' : ''}${outside(list) ? `, ${outside(list)} outside range` : ''}` : 'No related results yet')
    : hasData ? `${series.length} markers${outside(series) ? `, ${outside(series)} outside range` : ', all in range'}` : 'Tap an organ to explore, or add your results.';
  const header = (
    <div className="sheet__head">
      <div><h2>{organ ? organ.name : hasData ? 'Overview' : 'Your body, mapped'}</h2><p>{sub}</p></div>
      {organ && <button className="btn btn--quiet sheet__x" onClick={() => selectOrgan(null)} aria-label="Back to the whole body">{Icon.close}</button>}
    </div>
  );
  return (
    <Sheet snap={snap} onSnap={setSnap} peek={96} header={header} label={organ ? `${organ.name} details` : 'Overview'} onCover={onCover}
      contentKey={organ ? organ.id : hasData ? 'overview' : 'welcome'}>
      {organ ? <OrganPanel organ={organ.id} series={series} compact /> : (
        <>
          {hasData && <div className="sheet__row" role="group" aria-label="Highlight a body system"><SystemButtons series={series} /></div>}
          <div className="section">
            <h3>Organs</h3>
            <div className="organ-grid"><OrganButtons series={series} /></div>
            <Legend />
          </div>
          {hasData ? <Overview series={series} /> : <Welcome />}
        </>
      )}
    </Sheet>
  );
}

export default function BodyMap({ hidden }: { hidden?: boolean }) {
  const series = useSeries();
  const selected = useHealth(s => s.selectedOrgan);
  const compact = useMedia(COMPACT);
  return (
    <main className="bodymap" hidden={hidden}>
      {!compact && <IndexPanel series={series} />}
      <section className="stage" aria-label="3D body model">
        <Suspense fallback={<div className="stage__title"><p>Loading the 3D model…</p></div>}><Stage /></Suspense>
        <StageOverlay compact={compact} />
      </section>
      {compact ? <BodySheet series={series} /> : (
        <aside className="context" aria-live="polite">
          {selected ? <OrganPanel organ={selected} series={series} /> : series.length ? <Overview series={series} /> : <Welcome />}
        </aside>
      )}
    </main>
  );
}
