import { useMemo } from 'react';
import { useHealth } from '../lib/store';
import { SYSTEM_LABELS } from '../lib/catalog';
import { useUI } from '../state/ui';
import { ORGANS } from '../anatomy/organs';
import { buildSeries, seriesForOrgan, systemCounts, type Series } from '../lib/derive';
import type { OrganId, SystemId } from '../types';
import { StagePanel } from '../components/stage/StagePanel';
import { ContextPanel } from '../components/context/ContextPanel';

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

export default function BodyMap({ hidden }: { hidden?: boolean }) {
  const series = useSeries();
  return (
    <main className="bodymap" hidden={hidden}>
      <IndexPanel series={series} />
      <StagePanel />
      <aside className="context" aria-live="polite">
        <ContextPanel series={series} />
      </aside>
    </main>
  );
}
