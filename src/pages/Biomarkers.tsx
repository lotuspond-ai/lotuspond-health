import { useMemo, useState } from 'react';
import { useHealth } from '../lib/store';
import { SYSTEM_LABELS } from '../lib/catalog';
import { buildSeries, formatDate, rankStatus, STATUS_WORD } from '../lib/derive';
import { RangeBar, Sparkline, Icon } from '../components/ui';
import { useUI } from '../state/ui';
import type { Status, SystemId } from '../types';

export default function Biomarkers() {
  const measurements = useHealth(s => s.measurements);
  const selectMarker = useHealth(s => s.selectMarker);
  const setUploadOpen = useUI(s => s.setUploadOpen);
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<'all' | 'out'>('all');
  const groups = useMemo(() => {
    const series = buildSeries(measurements).filter(s => (only === 'all' || s.latest.status === 'high' || s.latest.status === 'low') && s.name.toLowerCase().includes(q.trim().toLowerCase()));
    const by = new Map<string, typeof series>();
    for (const s of series) { const k = s.def?.system ?? 'other'; (by.get(k) ?? by.set(k, []).get(k)!).push(s); }
    for (const list of by.values()) list.sort((a, b) => rankStatus(a.latest.status) - rankStatus(b.latest.status) || a.name.localeCompare(b.name));
    return [...by.entries()].sort((a, b) => (SYSTEM_LABELS[a[0] as SystemId] ?? 'zz').localeCompare(SYSTEM_LABELS[b[0] as SystemId] ?? 'zz'));
  }, [measurements, q, only]);

  return (
    <main className="page">
      <div className="page__head">
        <div><h1>Biomarkers</h1><p>Latest value of every marker you have uploaded, grouped by body system. Select one to see its history.</p></div>
        <span className="spacer" />
        <div className="seg" role="group" aria-label="Filter">
          <button aria-pressed={only === 'all'} onClick={() => setOnly('all')}>All</button>
          <button aria-pressed={only === 'out'} onClick={() => setOnly('out')}>Outside range</button>
        </div>
        <input className="search" type="search" placeholder="Find a marker, e.g. ferritin" value={q} onChange={e => setQ(e.target.value)} aria-label="Find a marker" />
      </div>
      {measurements.length === 0 ? (
        <div className="callout"><p className="lede" style={{ marginBottom: 12 }}>No results yet. Upload a lab report to fill this page.</p><button className="btn btn--primary" onClick={() => setUploadOpen(true)}>{Icon.upload} Upload results</button></div>
      ) : (
        <table className="table">
          <thead><tr><th>Marker</th><th>Latest</th><th style={{ width: '22%' }}>Position in range</th><th>Range</th><th>Trend</th><th>Date</th></tr></thead>
          <tbody>
            {groups.map(([sys, list]) => [
              <tr key={sys} className="group"><td colSpan={6}>{SYSTEM_LABELS[sys as SystemId] ?? 'Unmatched rows'}</td></tr>,
              ...list.map(s => {
                const m = s.latest; const st: Status = m.status;
                return (
                  <tr key={s.key} className="click" onClick={() => selectMarker(s.key)} tabIndex={0} onKeyDown={e => e.key === 'Enter' && selectMarker(s.key)}>
                    <td><b style={{ fontWeight: 600 }}>{s.name}</b><div className={`st-${st}`} style={{ fontSize: 13 }}>{STATUS_WORD[st]}</div></td>
                    <td><b style={{ fontWeight: 600 }}>{m.valueText}</b> <span className="muted">{m.unit}</span></td>
                    <td><RangeBar m={m} /></td>
                    <td className="muted">{m.range?.text ?? (m.range ? `${m.range.low ?? ''}–${m.range.high ?? ''}` : '—')}{m.range?.source === 'typical' ? ' (typical)' : ''}</td>
                    <td><Sparkline points={s.points} /></td>
                    <td className="muted">{formatDate(m.date)}</td>
                  </tr>
                );
              }),
            ])}
          </tbody>
        </table>
      )}
    </main>
  );
}
