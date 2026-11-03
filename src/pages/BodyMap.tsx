import { useCallback, useEffect, useMemo, useState } from 'react';
import { useHealth } from '../lib/store';
import { SYSTEM_LABELS } from '../lib/catalog';
import { useUI } from '../state/ui';
import { ORGANS, organOrNull } from '../anatomy/organs';
import { buildSeries, seriesForOrgan, systemCounts, type Series } from '../lib/derive';
import type { OrganId, SystemId } from '../types';
import { StagePanel } from '../components/stage/StagePanel';
import { ContextPanel } from '../components/context/ContextPanel';
import { Sheet, type Snap } from '../components/Sheet';
import { Icon } from '../components/ui';
import { COMPACT, useMedia } from '../lib/useMedia';

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

/** Phone layout: the results panel as a bottom sheet over the body map. */
function BodySheet({ series }: { series: Series[] }) {
  const selected = useHealth(s => s.selectedOrgan), selectOrgan = useHealth(s => s.selectOrgan);
  const loading = useHealth(s => s.loading);
  const setStageInset = useUI(s => s.setStageInset);
  const hasData = series.length > 0;
  const [snap, setSnap] = useState<Snap>(() => (selected ? 'half' : !loading && hasData ? 'peek' : 'half'));
  // Open to half when an organ is chosen, fold down when going back to the whole body, and fold once a profile's
  // results have loaded (half-open with the welcome text when there are none).
  const [seen, setSeen] = useState({ selected, loading });
  if (seen.selected !== selected || seen.loading !== loading) {
    setSeen({ selected, loading });
    if (seen.selected !== selected) setSnap(selected ? 'half' : 'peek');
    else if (!loading) setSnap(hasData ? 'peek' : 'half');
  }
  const onCover = useCallback((px: number) => setStageInset(px), [setStageInset]);
  useEffect(() => () => setStageInset(0), [setStageInset]); // back to the full stage when the sheet goes away

  const organ = organOrNull(selected);
  const list = selected ? seriesForOrgan(series, selected) : [];
  const outside = (l: Series[]) => l.filter(s => s.latest.status === 'high' || s.latest.status === 'low').length;
  const sub = organ
    ? (list.length ? `${list.length} related result${list.length > 1 ? 's' : ''}${outside(list) ? `, ${outside(list)} outside range` : ''}` : 'No related results yet')
    : loading ? 'Loading results…'
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
      {!organ && (
        <>
          {hasData && <div className="sheet__row" role="group" aria-label="Highlight a body system"><SystemButtons series={series} /></div>}
          <div className="section">
            <h3>Organs</h3>
            <div className="organ-grid"><OrganButtons series={series} /></div>
          </div>
        </>
      )}
      <ContextPanel series={series} />
    </Sheet>
  );
}

export default function BodyMap({ hidden }: { hidden?: boolean }) {
  const series = useSeries();
  const compact = useMedia(COMPACT);
  const cover = useUI(s => s.stageInset);
  return (
    <main className="bodymap" hidden={hidden} style={compact ? { ['--cover' as string]: `${cover}px` } : undefined}>
      {!compact && <IndexPanel series={series} />}
      <StagePanel />
      {compact ? <BodySheet series={series} /> : (
        <aside className="context" aria-live="polite">
          <ContextPanel series={series} />
        </aside>
      )}
    </main>
  );
}
