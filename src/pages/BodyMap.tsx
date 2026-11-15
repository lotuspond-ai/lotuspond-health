import { useCallback, useEffect, useMemo, useState } from 'react';
import { useHealth } from '../lib/store';
import { useUI } from '../state/ui';
import { organOrNull } from '../anatomy/organs';
import { buildSeries, seriesForOrgan, type Series } from '../lib/derive';
import { StagePanel } from '../components/stage/StagePanel';
import { ContextPanel } from '../components/context/ContextPanel';
import { Sheet, type Snap } from '../components/Sheet';
import { Icon } from '../components/ui';
import { COMPACT, useMedia } from '../lib/useMedia';

function useSeries() {
  const measurements = useHealth(s => s.measurements);
  return useMemo(() => buildSeries(measurements), [measurements]);
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
    : hasData ? (outside(series) ? `${outside(series)} result${outside(series) > 1 ? 's' : ''} to look at` : 'Everything is within range') : 'Tap an organ to explore, or add your results.';
  const header = (
    <div className="sheet__head">
      <div><h2>{organ ? organ.name : hasData ? 'Your brief' : 'Your body, mapped'}</h2><p>{sub}</p></div>
      {organ && <button className="btn btn--quiet sheet__x" onClick={() => selectOrgan(null)} aria-label="Back to the whole body">{Icon.close}</button>}
    </div>
  );
  return (
    <Sheet snap={snap} onSnap={setSnap} peek={96} header={header} label={organ ? `${organ.name} details` : 'Overview'} onCover={onCover}
      contentKey={organ ? organ.id : hasData ? 'overview' : 'welcome'}>
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
      <StagePanel />
      {compact ? <BodySheet series={series} /> : (
        <aside className="context" aria-live="polite">
          <ContextPanel series={series} />
        </aside>
      )}
    </main>
  );
}
