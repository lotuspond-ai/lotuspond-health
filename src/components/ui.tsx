import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Measurement, RefRange, Status } from '../types';
import { formatDate, STATUS_WORD } from '../lib/derive';
import { displayMeasurement, type DisplayValue } from '../lib/units';
import { useUnitSystem } from '../state/session';
import { StatusIcon } from './icons';
import { rangeText } from './context/summary';
import '../styles/visual.css';

export const Icon = {
  home: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 11l8-7 8 7" /><path d="M6 10v10h12V10" /><path d="M10 20v-5h4v5" /></svg>,
  agent: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="5" y="8" width="14" height="11" rx="3" /><path d="M12 8V5" /><circle cx="12" cy="4" r="1" /><circle cx="9.5" cy="13" r="1" /><circle cx="14.5" cy="13" r="1" /><path d="M10 16.5h4" /></svg>,
  upload: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 16V4M7 9l5-5 5 5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" /></svg>,
  lock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>,
  close: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>,
  back: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 6l-6 6 6 6" /></svg>,
  body: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="12" cy="5" r="2.2" /><path d="M8 21l1-7-3-1 2-5h8l2 5-3 1 1 7" /></svg>,
  chevron: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7" /></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>,
  user: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="12" cy="8" r="3.6" /><path d="M5 20c1.2-3.6 4-5.4 7-5.4s5.8 1.8 7 5.4" /></svg>,
  key: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="8" cy="15" r="4" /><path d="M11 12l8-8M16 7l2 2M14 9l2 2" /></svg>,
  out: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 8l-4 4 4 4M6 12h10" /></svg>,
  file: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z" /><path d="M14 3v4h4M9 13h6M9 17h4" /></svg>,
  image: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="4" y="4" width="16" height="16" rx="2" /><circle cx="9" cy="9.5" r="1.6" /><path d="M20 15l-4.5-4.5L6 20" /></svg>,
  download: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 4v12M7 11l5 5 5-5M4 20h16" /></svg>,
  eye: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></svg>,
  markers: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 12h4l2-6 4 12 2-6h6" /></svg>,
  scans: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3.5" y="4" width="17" height="16" rx="3" /><path d="M8 9.5c1.5-1 2.5-1 4 0s2.5 1 4 0M8 14.5c1.5-1 2.5-1 4 0s2.5 1 4 0" /></svg>,
  camera: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>,
  share: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 15V3M7 8l5-5 5 5M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6" /></svg>,
  trash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>,
  heart: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10z" /></svg>,
  pin: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.4" /></svg>,
};

export function Logo() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden>
      {/* The bloom: five tomato petals on an off-white disc (design system, Illustration). */}
      <circle cx="32" cy="32" r="30" fill="#f7f5ef" />
      <ellipse cx="32" cy="22" rx="6" ry="11" transform="rotate(0 32 32)" fill="#e8412c" /><ellipse cx="32" cy="22" rx="6" ry="11" transform="rotate(72 32 32)" fill="#e8412c" /><ellipse cx="32" cy="22" rx="6" ry="11" transform="rotate(144 32 32)" fill="#e8412c" /><ellipse cx="32" cy="22" rx="6" ry="11" transform="rotate(216 32 32)" fill="#e8412c" /><ellipse cx="32" cy="22" rx="6" ry="11" transform="rotate(288 32 32)" fill="#e8412c" />
      <circle cx="32" cy="32" r="4" fill="#18211b" />
    </svg>
  );
}

/* ---------------- status ---------------- */

/** Colored chip with an icon and a word, so status never rests on color alone. */
export function StatusChip({ status, label, size = 'md' }: { status: Status; label?: string; size?: 'sm' | 'md' }) {
  return <span className={`schip schip--${status} schip--${size}`}><StatusIcon status={status} size={size === 'sm' ? 13 : 15} />{label ?? STATUS_WORD[status]}</span>;
}

/** A value and its unit in the person's unit system. */
export function MeasureValue({ m, className = 'mval' }: { m: Measurement; className?: string }) {
  const d = displayMeasurement(m, useUnitSystem());
  return <span className={className}><b>{d.text}</b>{d.unit && <small>{d.unit}</small>}</span>;
}

/* ---------------- range bar ---------------- */

interface BarGeometry { bandL: number; bandR: number; pos: (v: number) => number }

/** Position of the in-range band on a 0–100 bar, and where a value falls on it. One-sided ranges open to the edge. */
function barGeometry(r: RefRange): BarGeometry | null {
  const { low, high } = r;
  if (low != null && high != null && high > low) {
    return { bandL: 22, bandR: 78, pos: v => 22 + ((v - low) / (high - low)) * 56 };
  }
  if (high != null && low == null && high > 0) return { bandL: 0, bandR: 78, pos: v => (v / high) * 78 };
  if (low != null && high == null && low > 0) return { bandL: 22, bandR: 100, pos: v => 22 + ((v - low) / low) * 56 };
  return null;
}

/** Where a value sits relative to its range. With `labels`, the range limits are printed under the band. */
export function RangeBar({ m, labels = false }: { m: Measurement; labels?: boolean }) {
  const d = displayMeasurement(m, useUnitSystem());
  const g = d.range ? barGeometry(d.range) : null;
  if (d.value == null || !d.range || !g) {
    return (
      <div className={`rbar rbar--empty${labels ? ' rbar--labels' : ''}`} role="img" aria-label={`${d.text} ${d.unit}. ${d.range ? rangeText(d.range) : 'No range given'}`}>
        <div className="rbar__track"><i className="rbar__zone rbar__zone--none" style={{ left: 0, right: 0 }} /></div>
        {labels && <div className="rbar__labels"><span style={{ left: '50%' }}>{d.range ? rangeText(d.range) : 'No range given'}</span></div>}
      </div>
    );
  }
  const pos = Math.max(2, Math.min(98, g.pos(d.value)));
  return (
    <div className={`rbar${labels ? ' rbar--labels' : ''}`} role="img" aria-label={`${STATUS_WORD[m.status]}: ${d.text} ${d.unit}, range ${rangeText(d.range)}${d.unit ? ` ${d.unit}` : ''}`}>
      <div className="rbar__track">
        {g.bandL > 0 && <i className="rbar__zone rbar__zone--low" style={{ left: 0, width: `calc(${g.bandL}% - 1px)` }} />}
        <i className="rbar__zone rbar__zone--in" style={{ left: g.bandL ? `calc(${g.bandL}% + 1px)` : 0, right: g.bandR < 100 ? `calc(${100 - g.bandR}% + 1px)` : 0 }} />
        {g.bandR < 100 && <i className="rbar__zone rbar__zone--high" style={{ left: `calc(${g.bandR}% + 1px)`, right: 0 }} />}
        <i className={`rbar__dot dot--${m.status}`} style={{ left: `${pos}%` }} />
      </div>
      {labels && (
        <div className="rbar__labels" aria-hidden>
          {d.range.low != null && <span style={{ left: `${g.bandL}%` }}>{d.range.low}</span>}
          {d.range.high != null && <span style={{ left: `${g.bandR}%` }}>{d.range.high}</span>}
        </div>
      )}
    </div>
  );
}

/* ---------------- shared chart helpers ---------------- */

interface Pt { m: Measurement; d: DisplayValue; v: number; t: number | null }

/** Numeric points in the latest point's display unit, oldest first. */
function chartPoints(points: Measurement[], system: 'conventional' | 'si'): Pt[] {
  const all = points.map(m => ({ m, d: displayMeasurement(m, system) })).filter(p => p.d.value != null);
  const unit = all[all.length - 1]?.d.unit;
  return all.filter(p => p.d.unit === unit).map(p => {
    const t = p.m.date ? Date.parse(p.m.date + 'T12:00:00') : NaN;
    return { ...p, v: p.d.value!, t: Number.isFinite(t) ? t : null };
  });
}

/** x position in [0, 1] for each point: by date when every point has one, else evenly spaced. */
function xShares(pts: Pt[]): number[] {
  const n = pts.length;
  if (n < 2) return pts.map(() => 0.5);
  const ts = pts.map(p => p.t);
  if (ts.every((t): t is number => t != null)) {
    const t0 = Math.min(...ts), t1 = Math.max(...ts);
    if (t1 > t0) return ts.map(t => (t - t0) / (t1 - t0));
  }
  return pts.map((_, i) => i / (n - 1));
}

/** Round tick values covering [lo, hi]. */
function niceTicks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / count, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f >= 5 ? 10 : f >= 2 ? 5 : f >= 1.5 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
  return out;
}

function fmtTick(v: number): string {
  const a = Math.abs(v);
  return a >= 10000 ? `${+(v / 1000).toFixed(1)}K` : a >= 100 ? String(Math.round(v)) : String(+v.toFixed(a >= 10 ? 1 : 2));
}

function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const first = Math.round(el.getBoundingClientRect().width);
    if (first > 0) setW(first);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => { const next = Math.round(e.contentRect.width); if (next > 0) setW(next); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/* ---------------- trend chart ---------------- */

/** Values over time, to scale on both axes, with the reference band. Hover or use arrow keys to read each point. */
export function TrendChart({ points, height = 230, title }: { points: Measurement[]; height?: number; title?: string }) {
  const system = useUnitSystem();
  const [wrap, W] = useWidth<HTMLDivElement>(460);
  const [active, setActive] = useState<number | null>(null);
  const pts = chartPoints(points, system);
  if (pts.length < 2) return <p className="note">One measurement so far. Upload another report with this marker to see how it changes over time.</p>;

  const H = height, P = { l: 44, r: 18, t: 30, b: 30 }, inset = 8;
  const iw = Math.max(80, W - P.l - P.r), ih = H - P.t - P.b;
  const last = pts[pts.length - 1];
  const r = last.d.range;
  const vals = pts.map(p => p.v);
  const bounds = [r?.low, r?.high].filter((b): b is number => b != null);
  const lo0 = Math.min(...vals, ...bounds), hi0 = Math.max(...vals, ...bounds);
  const pad = (hi0 - lo0 || Math.abs(hi0) || 1) * 0.14;
  let ticks = niceTicks(lo0 - pad, hi0 + pad, 4);
  const y0 = Math.min(lo0 - pad, ticks[0]), y1 = Math.max(hi0 + pad, ticks[ticks.length - 1]);
  ticks = ticks.filter(t => t >= y0 && t <= y1);
  const shares = xShares(pts);
  const x = (i: number) => P.l + inset + shares[i] * (iw - inset * 2);
  const y = (v: number) => P.t + (1 - (v - y0) / (y1 - y0)) * ih;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${P.t + ih} L${x(0).toFixed(1)},${P.t + ih} Z`;
  const bandTop = r?.high != null ? y(r.high) : P.t, bandBot = r?.low != null ? y(r.low) : P.t + ih;
  const hasBand = !!r && (r.low != null || r.high != null);
  const bandY = Math.max(P.t, bandTop), bandH = Math.max(0, Math.min(P.t + ih, bandBot) - bandY);

  // Date labels: first and last always, others where they do not collide.
  const multiYear = new Set(pts.map(p => p.m.date?.slice(0, 4))).size > 1;
  const fmt = (p: Pt) => formatDate(p.m.date, multiYear ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
  const labelAt = new Set<number>([0, pts.length - 1]);
  let lastX = x(0);
  for (let i = 1; i < pts.length - 1; i++) {
    if (x(i) - lastX >= 64 && x(pts.length - 1) - x(i) >= 64) { labelAt.add(i); lastX = x(i); }
  }
  if (x(pts.length - 1) - x(0) < 64) labelAt.delete(0);

  const nearest = (px: number) => {
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    return best;
  };
  const a = active != null ? pts[active] : null;
  const ex = x(pts.length - 1), ey = y(last.v);
  const endAnchor = ex > W - 70 ? 'end' : 'middle';
  const endLabelY = ey - 12 < P.t - 14 ? ey + 22 : ey - 12;
  const name = title ? `${title} over time` : 'Values over time';
  const summary = `${name}: ${pts.length} results from ${formatDate(pts[0].m.date)} to ${formatDate(last.m.date)}, latest ${last.d.text} ${last.d.unit}${hasBand ? `, range ${rangeText(r)}` : ''}.`;

  return (
    <div className="tchart" ref={wrap} tabIndex={0} role="group" aria-label={`${summary} Use the left and right arrow keys to read each value.`}
      onFocus={() => setActive(a => a ?? pts.length - 1)} onBlur={() => setActive(null)}
      onKeyDown={e => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          setActive(i => Math.max(0, Math.min(pts.length - 1, (i ?? pts.length - 1) + (e.key === 'ArrowRight' ? 1 : -1))));
        } else if (e.key === 'Home') { e.preventDefault(); setActive(0); } else if (e.key === 'End') { e.preventDefault(); setActive(pts.length - 1); }
      }}>
      <svg className="tchart__svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden
        onPointerMove={e => { const b = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); setActive(nearest(e.clientX - b.left)); }}
        onPointerLeave={() => setActive(null)}>
        {ticks.map(t => (
          <g key={t}>
            <line className="tc-grid" x1={P.l} x2={P.l + iw} y1={y(t)} y2={y(t)} />
            <text className="tc-tick" x={P.l - 8} y={y(t)} dy="0.32em" textAnchor="end">{fmtTick(t)}</text>
          </g>
        ))}
        {hasBand && bandH > 0 && <rect className="tc-band" x={P.l} width={iw} y={bandY} height={bandH} rx="3" />}
        {hasBand && bandH >= 18 && <text className="tc-bandlabel" x={P.l + 6} y={bandY + 13}>In range</text>}
        <line className="tc-axis" x1={P.l} x2={P.l + iw} y1={P.t + ih} y2={P.t + ih} />
        <path className="tc-area" d={area} />
        <path className="tc-line" d={line} />
        {a && <line className="tc-cross" x1={x(active!)} x2={x(active!)} y1={P.t} y2={P.t + ih} />}
        {pts.map((p, i) => {
          const end = i === pts.length - 1;
          return <circle key={p.m.id} className={`tc-dot dot--${p.m.status}`} cx={x(i)} cy={y(p.v)} r={end ? 6 : active === i ? 6 : 4.5} />;
        })}
        <text className="tc-endlabel" x={ex} y={endLabelY} textAnchor={endAnchor}>{last.d.text}<tspan className="tc-endunit"> {last.d.unit}</tspan></text>
        {pts.map((p, i) => labelAt.has(i) && (
          <text key={p.m.id} className="tc-tick" x={x(i)} y={H - 8} textAnchor={i === 0 && shares.length > 1 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}>{fmt(p)}</text>
        ))}
      </svg>
      {a && (
        <div className={`tchart__tip${x(active!) + 170 > W ? ' tchart__tip--left' : ''}`} style={{ left: x(active!), top: P.t }}>
          <b>{a.d.text}<small> {a.d.unit}</small></b>
          <span>{formatDate(a.m.date)}</span>
          <StatusChip status={a.m.status} size="sm" />
        </div>
      )}
      <span className="sr-only" aria-live="polite">{a ? `${formatDate(a.m.date)}: ${a.d.text} ${a.d.unit}, ${STATUS_WORD[a.m.status]}` : ''}</span>
    </div>
  );
}

/* ---------------- sparkline ---------------- */

/** Small trend line, to scale in time, with a faint in-range band and the latest point marked. */
export function Sparkline({ points, width = 72, height = 24 }: { points: Measurement[]; width?: number; height?: number }) {
  const system = useUnitSystem();
  const pts = chartPoints(points, system);
  if (pts.length < 2) return null;
  const W = width, H = height, pad = 4;
  const vals = pts.map(p => p.v);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || Math.abs(hi) || 1;
  const y0 = lo - span * 0.12, y1 = hi + span * 0.12;
  const shares = xShares(pts);
  const x = (i: number) => pad + shares[i] * (W - pad * 2);
  const y = (v: number) => pad + (1 - (v - y0) / (y1 - y0)) * (H - pad * 2);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`;
  const r = pts[pts.length - 1].d.range;
  const top = r?.high != null ? Math.max(0, y(r.high)) : 0, bot = r?.low != null ? Math.min(H, y(r.low)) : H;
  const showBand = !!r && (r.low != null || r.high != null) && bot > top;
  const last = pts.length - 1;
  return (
    <svg className="spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden focusable="false">
      {showBand && <rect className="spark__band" x={0} width={W} y={top} height={bot - top} />}
      <path className="spark__area" d={area} />
      <path className="spark__line" d={line} />
      <circle className={`spark__end dot--${pts[last].m.status}`} cx={x(last)} cy={y(pts[last].v)} r={3} />
    </svg>
  );
}

/* ---------------- part-to-whole figures ---------------- */

const RING_ORDER: Status[] = ['normal', 'high', 'low', 'unknown'];

/** Ring of latest results by status, with a 2px gap between parts. Pair it with a legend that lists the counts. */
export function StatusRing({ counts, size = 132, stroke = 14, children, label }: {
  counts: Record<Status, number>; size?: number; stroke?: number; children?: ReactNode; label: string;
}) {
  const total = RING_ORDER.reduce((n, s) => n + counts[s], 0);
  const rad = (size - stroke) / 2, C = 2 * Math.PI * rad, gap = total > 1 ? 2 : 0;
  const parts = RING_ORDER.filter(s => counts[s] > 0);
  let acc = 0;
  return (
    <div className="ring" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle className="ring__track" cx={size / 2} cy={size / 2} r={rad} strokeWidth={stroke} />
        {total > 0 && parts.map(s => {
          const len = (counts[s] / total) * C;
          const dash = Math.max(0.01, len - (parts.length > 1 ? gap : 0));
          const el = (
            <circle key={s} className={`ring__part ring__part--${s}`} cx={size / 2} cy={size / 2} r={rad} strokeWidth={stroke}
              strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-acc} transform={`rotate(-90 ${size / 2} ${size / 2})`}>
              <title>{`${STATUS_WORD[s]}: ${counts[s]}`}</title>
            </circle>
          );
          acc += len;
          return el;
        })}
      </svg>
      <div className="ring__center">{children}</div>
    </div>
  );
}

/** Thin bar split by status. Decorative: the text beside it carries the counts. */
export function SegBar({ counts }: { counts: Record<Status, number> }) {
  const total = RING_ORDER.reduce((n, s) => n + counts[s], 0);
  if (!total) return null;
  return (
    <span className="segbar" aria-hidden>
      {RING_ORDER.filter(s => counts[s] > 0).map(s => <i key={s} className={`segbar__part dot--${s}`} style={{ flexGrow: counts[s] }} />)}
    </span>
  );
}
