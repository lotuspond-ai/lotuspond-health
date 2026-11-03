import type { Measurement, RefRange } from '../types';
import { formatDate, STATUS_WORD } from '../lib/derive';

export const Icon = {
  upload: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 16V4M7 9l5-5 5 5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" /></svg>,
  lock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>,
  close: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>,
  back: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 6l-6 6 6 6" /></svg>,
  body: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="12" cy="5" r="2.2" /><path d="M8 21l1-7-3-1 2-5h8l2 5-3 1 1 7" /></svg>,
  markers: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 12h4l2-6 4 12 2-6h6" /></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>,
  scans: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3.5" y="4" width="17" height="16" rx="3" /><path d="M8 9.5c1.5-1 2.5-1 4 0s2.5 1 4 0M8 14.5c1.5-1 2.5-1 4 0s2.5 1 4 0" /></svg>,
  data: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" /></svg>,
  camera: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>,
  share: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 15V3M7 8l5-5 5 5M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6" /></svg>,
  trash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>,
};

export function Logo() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden>
      <circle cx="32" cy="32" r="30" fill="#0c2528" />
      <path d="M32 14c5 6 7 12 7 18s-3 12-7 16c-4-4-7-10-7-16s2-12 7-18z" fill="#e2869e" />
      <path d="M14 30c7 0 12 3 15 8 2 3 3 7 3 10-6 0-12-2-15-7-2-3-3-7-3-11zM50 30c-7 0-12 3-15 8-2 3-3 7-3 10 6 0 12-2 15-7 2-3 3-7 3-11z" fill="#f2b3c4" />
      <path d="M12 50c6 2 13 3 20 3s14-1 20-3" stroke="#5fbf95" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

const markColor = { high: 'var(--pollen-bright)', low: 'var(--dusk)', normal: 'var(--lily)', unknown: 'var(--reed)' } as const;

/** Where a value sits relative to its range; the in-range band always spans the middle of the bar. */
export function RangeBar({ m }: { m: Measurement }) {
  const r: RefRange | null = m.range;
  if (m.value == null || !r || (r.low == null && r.high == null)) return <div className="range" aria-hidden><div className="range__track" style={{ opacity: 0.35 }} /></div>;
  const lo = r.low ?? 0, hi = r.high ?? (r.low ?? 1) * 2;
  const span = hi - lo || 1;
  const pos = 22 + ((m.value - lo) / span) * 56;
  return (
    <div className="range" role="img" aria-label={`${STATUS_WORD[m.status]}: ${m.valueText} ${m.unit}, range ${r.text ?? `${r.low ?? ''}–${r.high ?? ''}`}`}>
      <div className="range__track" />
      <div className="range__mark" style={{ left: `${Math.max(3, Math.min(97, pos))}%`, background: markColor[m.status] }} />
    </div>
  );
}

export function TrendChart({ points }: { points: Measurement[] }) {
  const pts = points.filter(p => p.value != null);
  if (pts.length < 2) return <p className="note">One measurement so far. Upload another report with this marker to see how it changes over time.</p>;
  const W = 460, H = 180, P = { l: 36, r: 16, t: 18, b: 30 };
  const vals = pts.map(p => p.value!);
  const r = pts[pts.length - 1].range;
  const lo = Math.min(...vals, r?.low ?? Infinity), hi = Math.max(...vals, r?.high ?? -Infinity);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.18, y0 = lo - pad, y1 = hi + pad;
  const x = (i: number) => P.l + (i / (pts.length - 1)) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - (v - y0) / (y1 - y0)) * (H - P.t - P.b);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value!).toFixed(1)}`).join(' ');
  return (
    <svg className="trend" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Values over time">
      {r && (r.low != null || r.high != null) && (
        <rect x={P.l} width={W - P.l - P.r} y={y(r.high ?? y1)} height={Math.max(0, y(r.low ?? y0) - y(r.high ?? y1))} fill="#d6ebe2" opacity="0.7" rx="4" />
      )}
      <path d={path} fill="none" stroke="#0e2a2e" strokeWidth="2" />
      {pts.map((p, i) => (
        <g key={p.id}>
          <circle cx={x(i)} cy={y(p.value!)} r="5" fill={markColor[p.status]} stroke="#f8fbfa" strokeWidth="2" />
          <text x={x(i)} y={y(p.value!) - 10} textAnchor="middle" style={{ fill: '#0e2a2e', fontWeight: 600 }}>{p.valueText}</text>
          <text x={x(i)} y={H - 8} textAnchor="middle">{formatDate(p.date, { month: 'short', year: '2-digit' })}</text>
        </g>
      ))}
    </svg>
  );
}

export function Sparkline({ points }: { points: Measurement[] }) {
  const v = points.filter(p => p.value != null).map(p => p.value!);
  if (v.length < 2) return null;
  const lo = Math.min(...v), hi = Math.max(...v), W = 64, H = 20;
  const d = v.map((n, i) => `${i ? 'L' : 'M'}${(i / (v.length - 1)) * W},${H - 2 - ((n - lo) / (hi - lo || 1)) * (H - 4)}`).join(' ');
  return <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden><path d={d} fill="none" stroke="#6b8a86" strokeWidth="1.6" /></svg>;
}
