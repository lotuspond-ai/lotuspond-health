// The default body map: images of the anatomy rendered at build time (tools/render-bodymap.mjs), turned by dragging
// or with the arrows. Hover, click, highlights and result pins work from per-angle ID maps, so nothing here needs
// WebGL and any device can use it. Opening an organ shows its pre-rendered close-up with landmarks.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { ORGAN_BY_ID } from '../../anatomy/organs';
import { organSummary, useHealth } from '../../lib/store';
import { useUI } from '../../state/ui';
import type { OrganId } from '../../types';
import { warmCache } from '../../sw-register';
import { Glyph } from '../stage/Glyph';
import { ORGAN_SYSTEMS, PINNED, STATUS_COLOR, pinLabel, pinState } from '../stage/status';
import { ISSUE_COLOR, ISSUE_RGB, pinIssueClass, useIssues } from '../stage/issues';
import type { IssueLevel } from '../../lib/attention';
import { ASPECT, ID_ORGAN, MANIFEST, ORGAN_INDEX, bodymapUrl, loadIdMap, preload, type Density, type IdMap } from './manifest';
import '../../styles/stage.css';

const N = MANIFEST.angles.length;
const wrap = (i: number) => ((i % N) + N) % N;
/** Horizontal drag that turns the body by one angle. */
const STEP_PX = 26;
const PINNED_IDS = new Set<OrganId>(PINNED.map(o => o.id));
const imageUrl = (angle: number, d: Density) => bodymapUrl(MANIFEST.angles[angle].image[d]);

function viewName(deg: number) {
  const names = ['front', 'front left', 'left side', 'back left', 'back', 'back right', 'right side', 'front right'];
  return names[Math.round(deg / 45) % 8];
}

const needs2x = (stageHeight: number) => stageHeight * (window.devicePixelRatio || 1) > MANIFEST.sizes['1x'][1] * 1.15;

/** Larger images for high-density screens and big stages. Guessed from the window before the first image is
 *  requested (the stage is about the window's height on wide screens, 72% of it on narrow ones), then only ever
 *  steps up, so images are not fetched twice. */
function useDensity(ref: RefObject<HTMLElement | null>): Density {
  const [d, setD] = useState<Density>(() => needs2x(window.innerWidth > 1180 ? window.innerHeight - 90 : Math.max(560, window.innerHeight * 0.72)) ? '2x' : '1x');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => { if (needs2x(el.getBoundingClientRect().height)) setD('2x'); };
    check();
    const ro = new ResizeObserver(check); ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return d;
}

/** Highlight for the hovered organ (fill and outline) and dimming of organs outside the chosen body system. */
function paintOverlay(canvas: HTMLCanvasElement, m: IdMap, hot: number, dim: Set<number> | null, dimAlpha = 165) {
  const g = canvas.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (!hot && !dim) return;
  const { width: w, height: h, ids } = m;
  const img = g.createImageData(w, h), px = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, id = ids[i], o = i * 4;
      if (hot) {
        const l = x > 0 ? ids[i - 1] : 0, r = x < w - 1 ? ids[i + 1] : 0, u = y > 0 ? ids[i - w] : 0, d = y < h - 1 ? ids[i + w] : 0;
        if (id === hot) {
          const edge = l !== hot || r !== hot || u !== hot || d !== hot;
          if (edge) { px[o] = 255; px[o + 1] = 226; px[o + 2] = 233; px[o + 3] = 250; } else { px[o] = 226; px[o + 1] = 134; px[o + 2] = 158; px[o + 3] = 64; }
          continue;
        }
        if (l === hot || r === hot || u === hot || d === hot) { px[o] = 226; px[o + 1] = 134; px[o + 2] = 158; px[o + 3] = 150; continue; }
      }
      if (dim && id && dim.has(id)) { px[o] = 8; px[o + 1] = 30; px[o + 2] = 33; px[o + 3] = dimAlpha; }
    }
  }
  g.putImageData(img, 0, 0);
}

/**
 * Organs with results outside their range, painted in their issue colour (src/components/stage/issues.ts): a soft fill
 * with a brighter rim. Its own canvas, so CSS can make it breathe without repainting.
 */
/** Where an organ's glow may go when its region spreads over the body (the heart and its vessels). */
interface Area { x: number; y: number; r: number }
const SPREAD = 0.12; // a box larger than this share of the image is a spread-out region
const AREA_R = 0.085;

function paintIssues(canvas: HTMLCanvasElement, m: IdMap, levels: Map<number, IssueLevel>, areas: Map<number, Area>) {
  const g = canvas.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (!levels.size) return;
  const { width: w, height: h, ids } = m;
  const img = g.createImageData(w, h), px = img.data;
  // A rim two pixels wide: any pixel of the organ with a different organ (or nothing) within two pixels.
  const rim = (x: number, y: number, id: number) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || ids[yy * w + xx] !== id) return true;
    }
    return false;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, id = ids[i];
      const lv = id ? levels.get(id) : undefined;
      if (!lv) continue;
      // Only the organ itself: the heart's region also holds every vessel of the body, so it is kept to a circle
      // around the heart.
      const a = areas.get(id);
      if (a && (x - a.x * w) ** 2 + (y - a.y * h) ** 2 > (a.r * w) ** 2) continue;
      const [r, gg, b] = ISSUE_RGB[lv], o = i * 4;
      px[o] = r; px[o + 1] = gg; px[o + 2] = b; px[o + 3] = rim(x, y, id) ? 255 : lv === 'far' ? 150 : 125;
    }
  }
  g.putImageData(img, 0, 0);
}

function Turntable({ angle, setAngle, density }: { angle: number; setAngle: (a: number) => void; density: Density }) {
  const hovered = useUI(s => s.hovered), setHovered = useUI(s => s.setHovered);
  const labels = useUI(s => s.layers.labels);
  const activeSystem = useHealth(s => s.activeSystem);
  const selectOrgan = useHealth(s => s.selectOrgan);
  const measurements = useHealth(s => s.measurements);
  const summary = useMemo(() => organSummary(measurements), [measurements]);
  const frame = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const issueLayer = useRef<HTMLCanvasElement>(null);
  const issues = useIssues().organs;
  const drag = useRef<{ id: number; x: number; start: number; moved: boolean } | null>(null);
  // The image on screen. A new angle replaces it once decoded; the previous one stays underneath while it fades in.
  const [shown, setShown] = useState(angle);
  const [under, setUnder] = useState<number | null>(null);
  const [ids, setIds] = useState<{ angle: number; map: IdMap } | null>(null);
  const idMap = ids?.angle === shown ? ids.map : null;

  useEffect(() => {
    if (angle === shown) return;
    let alive = true;
    const img = new Image(); img.src = imageUrl(angle, density);
    img.decode().catch(() => {}).then(() => { if (alive) { setUnder(shown); setShown(angle); } });
    return () => { alive = false; };
  }, [angle, shown, density]);

  // Neighbouring angles download ahead; ID maps decode after the image is up.
  useEffect(() => {
    for (const k of [1, -1, 2, -2]) preload(imageUrl(wrap(shown + k), density));
    let alive = true;
    void loadIdMap(shown).then(map => { if (alive) setIds({ angle: shown, map }); }).catch(() => {});
    const t = setTimeout(() => { void loadIdMap(wrap(shown + 1)).catch(() => {}); void loadIdMap(wrap(shown - 1)).catch(() => {}); }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [shown, density]);

  // Opening an organ shows its close-up: fetch it while the pointer rests on the organ.
  useEffect(() => {
    if (!hovered) return;
    const c = MANIFEST.closeups[hovered];
    const t = c && setTimeout(() => preload(bodymapUrl(c.image[density])), 160);
    return () => clearTimeout(t);
  }, [hovered, density]);

  useEffect(() => {
    if (!overlay.current) return;
    const hot = hovered ? ORGAN_INDEX[hovered] ?? 0 : 0;
    // A chosen body system dims everything else; otherwise, when results are outside range, the healthy organs step
    // back a little so the glowing ones stand out.
    const calm = !activeSystem && Object.keys(issues).length > 0;
    const dim = activeSystem ? new Set(ID_ORGAN.flatMap((o, i) => (o && !ORGAN_SYSTEMS[o]?.has(activeSystem) ? [i] : [])))
      : calm ? new Set(ID_ORGAN.flatMap((o, i) => (o && o !== 'skin' && !issues[o] ? [i] : []))) : null;
    if (idMap) paintOverlay(overlay.current, idMap, hot, dim, activeSystem ? 165 : 70);
  }, [idMap, hovered, activeSystem, issues]);

  useEffect(() => {
    if (!issueLayer.current || !idMap) return;
    // A chosen body system takes over the highlighting.
    const levels = new Map<number, IssueLevel>(activeSystem ? [] : Object.entries(issues).map(([o, lv]) => [ORGAN_INDEX[o as OrganId] ?? 0, lv as IssueLevel]));
    levels.delete(0);
    const view = MANIFEST.angles[shown], areas = new Map<number, Area>();
    for (const o of Object.keys(issues) as OrganId[]) {
      const b = view.boxes[o], p = view.pins[o];
      if (b && p && (b[2] - b[0]) * (b[3] - b[1]) > SPREAD) areas.set(ORGAN_INDEX[o] ?? 0, { x: p[0], y: p[1], r: AREA_R });
    }
    paintIssues(issueLayer.current, idMap, levels, areas);
  }, [idMap, issues, activeSystem, shown]);

  const organAt = async (clientX: number, clientY: number, wait: boolean): Promise<OrganId | null> => {
    const m = idMap ?? (wait ? await loadIdMap(shown).catch(() => null) : null);
    const el = frame.current;
    if (!m || !el) return null;
    const r = el.getBoundingClientRect();
    const x = Math.floor(((clientX - r.left) / r.width) * m.width), y = Math.floor(((clientY - r.top) / r.height) * m.height);
    if (x < 0 || y < 0 || x >= m.width || y >= m.height) return null;
    return ID_ORGAN[m.ids[y * m.width + x]];
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, start: angle, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      const dx = e.clientX - d.x;
      if (!d.moved && Math.abs(dx) > 6) { d.moved = true; e.currentTarget.setPointerCapture(e.pointerId); setHovered(null); }
      // Dragging right turns the front of the body to the right.
      if (d.moved) { setAngle(wrap(d.start - Math.round(dx / STEP_PX))); return; }
    }
    if (e.pointerType !== 'mouse' || d?.moved) return;
    void organAt(e.clientX, e.clientY, false).then(o => { if (o !== useUI.getState().hovered) setHovered(o); });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current; drag.current = null;
    if (!d || d.moved || d.id !== e.pointerId) return;
    void organAt(e.clientX, e.clientY, true).then(o => { if (o) selectOrgan(o); });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowLeft') setAngle(wrap(angle + 1));
    else if (e.key === 'ArrowRight') setAngle(wrap(angle - 1));
    else if (e.key === 'Home') setAngle(0);
    else return;
    e.preventDefault();
  };

  const view = MANIFEST.angles[shown];
  const box = hovered ? view.boxes[hovered] : undefined;
  const tag = hovered && box && (!labels || !PINNED_IDS.has(hovered));
  const [iw, ih] = MANIFEST.idSize;
  return (
    <>
      <div ref={frame} className="bm2d__frame" role="group" tabIndex={0} aria-roledescription="body map"
        aria-label={`Body map, ${viewName(view.deg)} view. Left and right arrow keys turn it; organ buttons open an organ.`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onKeyDown={onKeyDown}
        onPointerCancel={() => { drag.current = null; }}
        onPointerLeave={e => { if (e.pointerType === 'mouse' && !drag.current) setHovered(null); }}
        style={{ cursor: hovered ? 'pointer' : undefined }}>
        {under !== null && under !== shown && <img className="bm2d__img" src={imageUrl(under, density)} alt="" draggable={false} />}
        <img key={shown} className="bm2d__img bm2d__img--in" src={imageUrl(shown, density)} alt="" draggable={false}
          onAnimationEnd={() => setUnder(null)} fetchPriority="high" />
        <canvas ref={issueLayer} className="bm2d__overlay bm2d__issues" width={iw} height={ih} aria-hidden />
        <canvas ref={overlay} className="bm2d__overlay" width={iw} height={ih} aria-hidden />
        {labels && (
          <div className="bm2d__pins">
            {PINNED.map(o => {
              const p = view.pins[o.id];
              if (!p) return null;
              const s = summary[o.id], state = pinState(s), hot = hovered === o.id;
              return (
                <div key={o.id} className={`bm2d__pin${p[2] < -0.045 ? ' is-back' : ''}`} style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%` }}>
                  <button className={`pin pin--${state}${hot ? ' is-hot' : ''}${pinIssueClass(issues, o.id)}`} style={{ ['--pin' as string]: issues[o.id] ? ISSUE_COLOR[issues[o.id]!] : STATUS_COLOR[state] }}
                    onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()} onClick={() => selectOrgan(o.id)}
                    onPointerEnter={() => setHovered(o.id)} onPointerLeave={() => setHovered(null)}
                    onFocus={() => setHovered(o.id)} onBlur={() => setHovered(null)} aria-label={pinLabel(o.name, s)}>
                    <span className="pin__dot" />
                    {(hot || state === 'out') && <span className="pin__label">{o.short}{s?.out ? <em>{s.out}</em> : null}</span>}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {tag && <div className="bm2d__tag" style={{ left: `${(box[0] + box[2]) * 50}%`, top: `${box[1] * 100}%` }} aria-hidden>{ORGAN_BY_ID[hovered].short}</div>}
      </div>
      <div className="bm2d__turn" role="group" aria-label="Turn the body">
        <button className="bm2d__arrow" aria-label="Turn left" onClick={() => setAngle(wrap(angle + 1))}><Glyph name="left" /></button>
        <span className="bm2d__dial" aria-hidden><i style={{ transform: `rotate(${view.deg}deg)` }} /></span>
        <button className="bm2d__arrow" aria-label="Turn right" onClick={() => setAngle(wrap(angle - 1))}><Glyph name="right" /></button>
      </div>
    </>
  );
}

function CloseUp({ organ, density }: { organ: OrganId; density: Density }) {
  const c = MANIFEST.closeups[organ]!;
  const o = ORGAN_BY_ID[organ];
  const labels = useUI(s => s.layers.labels);
  const selectOrgan = useHealth(s => s.selectOrgan);
  const src = bodymapUrl(c.image[density]);
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const img = new Image(); img.src = src;
    img.decode().catch(() => {}).then(() => { if (alive) setReady(src); });
    return () => { alive = false; };
  }, [src]);
  return (
    <div className="bm2d__frame bm2d__frame--close" role="group" tabIndex={0} aria-label={`${o.name}, close-up. Escape returns to the whole body.`}
      onKeyDown={e => { if (e.key === 'Escape') selectOrgan(null); }}>
      {ready ? <img className="bm2d__img bm2d__img--in" src={ready} alt="" draggable={false} /> : <div className="stage-loading bm2d__wait">Opening {o.short}…</div>}
      {labels && ready && (
        <div className="bm2d__marks">
          {o.landmarks.map((l, i) => {
            const p = c.landmarks[i];
            if (!p) return null;
            return (
              <div key={l.name} className={`bm2d__mark${p[2] < -0.03 ? ' is-back' : ''}`} style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%` }}>
                <div className="landmark" tabIndex={0}>
                  <span className="landmark__dot" />
                  <span className="landmark__name">{l.name}</span>
                  <span className="landmark__note">{l.note}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Pre-rendered body map for the stage. */
export function BodyMap2D() {
  const root = useRef<HTMLDivElement>(null);
  const density = useDensity(root);
  const [angle, setAngle] = useState(0);
  const selected = useHealth(s => s.selectedOrgan);
  const close = selected && selected !== 'skin' && MANIFEST.closeups[selected] ? selected : null;

  // Once the first view is up, let the service worker keep every image of this size for next time (and offline).
  useEffect(() => {
    const files = (d: Density) => [
      ...MANIFEST.angles.flatMap(a => [a.image[d], a.id]),
      ...Object.values(MANIFEST.closeups).map(c => c!.image[d]),
    ].map(bodymapUrl);
    const t = setTimeout(() => warmCache(files(density), [...files('1x'), ...files('2x')]), 5000);
    return () => clearTimeout(t);
  }, [density]);

  return (
    <div ref={root} className="bm2d" style={{ ['--ar' as string]: ASPECT, background: MANIFEST.background }}>
      {close ? <CloseUp key={close} organ={close} density={density} /> : <Turntable angle={angle} setAngle={setAngle} density={density} />}
    </div>
  );
}
