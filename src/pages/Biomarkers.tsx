import { useMemo, useState } from 'react';
import { useHealth } from '../lib/store';
import { buildSeries, formatDate, type Series } from '../lib/derive';
import { displayMeasurement } from '../lib/units';
import { useUnitSystem } from '../state/session';
import { RangeBar, Sparkline, Icon, SegBar, StatusChip } from '../components/ui';
import { ArrowIcon, SystemIcon, UiIcon } from '../components/icons';
import { MarkerCard } from '../components/context/MarkerCard';
import {
  groupBySystem, groupStatus, isOut, rangeText, statusCounts, systemLabel, useMarkerView, type MarkerFilter, type StatusCounts, type SystemKey,
} from '../components/context/summary';
import { useUI } from '../state/ui';

function GroupCounts({ c }: { c: StatusCounts }) {
  return (
    <span className="bm-group__counts">
      <span>{c.total} marker{c.total > 1 ? 's' : ''}</span>
      {c.high > 0 && <span className="flag flag--high"><ArrowIcon dir="up" />{c.high}<span className="sr-only"> above range</span></span>}
      {c.low > 0 && <span className="flag flag--low"><ArrowIcon dir="down" />{c.low}<span className="sr-only"> below range</span></span>}
      {!c.high && !c.low && c.normal > 0 && <span className="flags__ok">{Icon.check} All in range</span>}
    </span>
  );
}

function TableRow({ s }: { s: Series }) {
  const selectMarker = useHealth(st => st.selectMarker);
  const m = s.latest;
  const d = displayMeasurement(m, useUnitSystem());
  return (
    <tr className="click" onClick={() => selectMarker(s.key)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectMarker(s.key); } }}>
      <td><b className="bm-table__name">{s.name}</b></td>
      <td><StatusChip status={m.status} size="sm" /></td>
      <td className="num"><b>{d.text}</b> <span className="muted">{d.unit}</span></td>
      <td style={{ minWidth: 150 }}><RangeBar m={m} /></td>
      <td className="muted">{d.range ? rangeText(d.range) : 'None'}{m.range?.source === 'typical' ? ' (typical)' : ''}</td>
      <td><Sparkline points={s.points} /></td>
      <td className="muted">{formatDate(m.date)}</td>
    </tr>
  );
}

export default function Biomarkers() {
  const measurements = useHealth(s => s.measurements);
  const setUploadOpen = useUI(s => s.setUploadOpen);
  const { filter, setFilter, layout, setLayout } = useMarkerView();
  const [q, setQ] = useState('');
  const all = useMemo(() => buildSeries(measurements), [measurements]);
  const allGroups = useMemo(() => groupBySystem(all), [all]);
  const totals = statusCounts(all);
  const outCount = totals.high + totals.low;
  // A system filter left over from another profile falls back to everything.
  const active: MarkerFilter = filter === 'all' || filter === 'out' || allGroups.some(g => g.system === filter) ? filter : 'all';
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const shown = all.filter(s => (active === 'all' || (active === 'out' ? isOut(s.latest.status) : (s.def?.system ?? 'other') === active))
      && (!needle || s.name.toLowerCase().includes(needle) || s.latest.rawName.toLowerCase().includes(needle)));
    return groupBySystem(shown);
  }, [all, active, q]);
  const shownCount = groups.reduce((n, g) => n + g.list.length, 0);

  const chip = (id: MarkerFilter, label: string, count: number, icon?: SystemKey) => (
    <button key={id} className="fchip" aria-pressed={active === id} onClick={() => setFilter(id)}>
      {icon && <SystemIcon system={icon} size={16} />}{label}<span className="fchip__n">{count}</span>
    </button>
  );

  return (
    <main className="page bm">
      <div className="page__head">
        <div><h1>Biomarkers</h1><p>Latest value of every marker, grouped by body system. Select one to see its history.</p></div>
        <span className="spacer" />
        {measurements.length > 0 && (
          <div className="bm-tools">
            <div className="seg" role="group" aria-label="Layout">
              <button aria-pressed={layout === 'cards'} onClick={() => setLayout('cards')}><UiIcon name="grid" size={15} />Cards</button>
              <button aria-pressed={layout === 'table'} onClick={() => setLayout('table')}><UiIcon name="list" size={15} />Table</button>
            </div>
            <label className="search-wrap">
              <UiIcon name="search" size={16} />
              <input className="search" type="search" placeholder="Find a marker, e.g. ferritin" value={q} onChange={e => setQ(e.target.value)} aria-label="Find a marker" />
            </label>
          </div>
        )}
      </div>
      {measurements.length === 0 ? (
        <div className="callout empty">
          <span className="empty__icon"><UiIcon name="chart" size={26} /></span>
          <p className="lede">No results yet. Upload a lab report to fill this page.</p>
          <button className="btn btn--primary" onClick={() => setUploadOpen(true)}>{Icon.upload} Upload results</button>
        </div>
      ) : (
        <>
          <div className="fchips" role="group" aria-label="Filter results">
            {chip('all', 'All', totals.total)}
            {chip('out', 'Outside range', outCount)}
            {allGroups.map(g => chip(g.system, systemLabel(g.system), g.counts.total, g.system))}
          </div>
          <p className="bm-count" aria-live="polite">{shownCount === all.length ? `${all.length} markers` : `Showing ${shownCount} of ${all.length} markers`}</p>
          {groups.length === 0 ? (
            <div className="callout"><p className="lede">{active === 'out' && !q ? 'Every latest result is within its range.' : 'No markers match.'}</p></div>
          ) : layout === 'cards' ? (
            groups.map(g => (
              <section key={g.system} className="bm-group" aria-labelledby={`grp-${g.system}`}>
                <header className="bm-group__head">
                  <span className={`sysicon sysicon--${groupStatus(g.counts)}`}><SystemIcon system={g.system} size={20} /></span>
                  <h2 id={`grp-${g.system}`}>{systemLabel(g.system)}</h2>
                  <GroupCounts c={g.counts} />
                  <SegBar counts={g.counts} />
                </header>
                <div className="mgrid">{g.list.map(s => <MarkerCard key={s.key} s={s} />)}</div>
              </section>
            ))
          ) : (
            <div className="table-wrap">
              <table className="table bm-table">
                <thead><tr><th>Marker</th><th>Status</th><th>Latest</th><th style={{ width: '20%' }}>Position in range</th><th>Range</th><th>Trend</th><th>Date</th></tr></thead>
                <tbody>
                  {groups.map(g => [
                    <tr key={g.system} className="group"><td colSpan={7}><span className="bm-table__group"><SystemIcon system={g.system} size={18} />{systemLabel(g.system)}</span></td></tr>,
                    ...g.list.map(s => <TableRow key={s.key} s={s} />),
                  ])}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  );
}
