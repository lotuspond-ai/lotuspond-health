// The default body map: images of the anatomy rendered at build time (tools/render-bodymap.mjs), turned by dragging
// or with the arrows. Hover, click, highlights and result pins work from per-angle ID maps, so nothing here needs
// WebGL and any device can use it. Opening an organ shows its pre-rendered close-up with landmarks.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { ORGAN_BY_ID, organOrNull } from '../../anatomy/organs';
import { organSummary, useHealth } from '../../lib/store';
import type { Body } from '../../lib/body';
import { useUI } from '../../state/ui';
import type { OrganId } from '../../types';
import { warmCache } from '../../sw-register';
import { Glyph } from '../stage/Glyph';
import { ORGAN_SYSTEMS, PINNED, STATUS_COLOR, pinLabel, pinState } from '../stage/status';
import { ISSUE_COLOR, ISSUE_RGB, pinIssueClass, useIssues } from '../stage/issues';
import { useStage } from '../stage/stageSettings';
import { useOrganLevels } from '../stage/grades';
import type { IssueLevel } from '../../lib/attention';
import { MANIFESTS, allBodymapFiles, bodymapFiles, bodymapUrl, loadIdMap, preload, viewOf, type AngleView, type BodyMapManifest, type Density, type IdMap } from './manifest';
import '../../styles/stage.css';

/** Horizontal drag that turns the body by one angle. */
const STEP_PX = 26;
const PINNED_IDS = new Set<OrganId>(PINNED.map(o => o.id));
const imageUrl = (m: BodyMapManifest, angle: number, d: Density) => bodymapUrl(m.angles[angle].image[d]);

function viewName(deg: number) {
  const names = ['front', 'front left', 'left side', 'back left', 'back', 'back right', 'right side', 'front right'];
  return names[Math.round(deg / 45) % 8];
}

// both bodies are rendered at the same sizes
const needs2x = (stageHeight: number) => stageHeight * (window.devicePixelRatio || 1) > (MANIFESTS.female.sizes['1x']?.[1] ?? 900) * 1.15;

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

/**
 * The "Glow" look: a soft halo on each organ that has results, green when they are all in range and in the issue
 * colours otherwise, in place of pins and the painted issue layer. Halos sit at the organ's pin and take its size
 * from its outline in this view; regions spread over the body (the heart and its vessels) keep to a circle.
 */
function Glows({ view, aspect, activeSystem }: {
  view: AngleView;
  /** Width over height of this body's images. */
  aspect: number;
  activeSystem: ReturnType<typeof useHealth.getState>['activeSystem'];
}) {
  const levels = useOrganLevels();
  return (
    <div className="bm2d__glows" aria-hidden>
      {PINNED.map(o => {
        const p = view.pins[o.id], b = view.boxes[o.id], lv = levels[o.id];
        if (!p || !b || lv === undefined) return null;
        if (activeSystem && !ORGAN_SYSTEMS[o.id]?.has(activeSystem)) return null;
        const spread = (b[2] - b[0]) * (b[3] - b[1]) > SPREAD;
        // Box sides are shares of the image's width and height; the halo is a bit larger than the organ.
        const w = spread ? AREA_R * 2.8 : Math.min(0.3, Math.max(0.12, (b[2] - b[0]) * 1.5));
        const h = spread ? AREA_R * 2.8 * aspect : Math.min(0.22, Math.max(0.08, (b[3] - b[1]) * 1.35));
        const rgb = lv ? ISSUE_RGB[lv] : GLOW_OK;
        return (
          <i key={o.id} className={`bm2d__glow${lv ? ` is-${lv}` : ''}${p[2] < -0.045 ? ' is-back' : ''}`}
            style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%`, width: `${w * 100}%`, height: `${h * 100}%`, ['--rgb' as string]: rgb.join(',') }} />
        );
      })}
    </div>
  );
}

/** In-range green of the glow look (the "In range" pin colour). */
const GLOW_OK: [number, number, number] = [95, 191, 149];

function Turntable({ body, angle, setAngle, density }: { body: Body; angle: number; setAngle: (a: number) => void; density: Density }) {
  const m = MANIFESTS[body], v = viewOf(body);
  const N = m.angles.length;
  const wrap = (i: number) => ((i % N) + N) % N;
  const hovered = useUI(s => s.hovered), setHovered = useUI(s => s.setHovered);
  const glow = useStage(s => s.glow);
  // The glow view hides pins and labels, but keeps the pin buttons for the keyboard and screen readers.
  const labels = useUI(s => s.layers.labels) && !glow;
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
    const img = new Image(); img.src = imageUrl(m, angle, density);
    img.decode().catch(() => {}).then(() => { if (alive) { setUnder(shown); setShown(angle); } });
    return () => { alive = false; };
  }, [m, angle, shown, density]);

  // Neighbouring angles download ahead; ID maps decode after the image is up.
  useEffect(() => {
    const wrap = (i: number) => ((i % N) + N) % N;
    for (const k of [1, -1, 2, -2]) preload(imageUrl(m, wrap(shown + k), density));
    let alive = true;
    void loadIdMap(body, shown).then(map => { if (alive) setIds({ angle: shown, map }); }).catch(() => {});
    const t = setTimeout(() => { void loadIdMap(body, wrap(shown + 1)).catch(() => {}); void loadIdMap(body, wrap(shown - 1)).catch(() => {}); }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [m, N, body, shown, density]);

  // Opening an organ shows its close-up: fetch it while the pointer rests on the organ.
  useEffect(() => {
    if (!hovered) return;
    const c = m.closeups[hovered];
    const t = c && setTimeout(() => preload(bodymapUrl(c.image[density])), 160);
    return () => clearTimeout(t);
  }, [m, hovered, density]);

  useEffect(() => {
    if (!overlay.current) return;
    const hot = hovered ? v.organIndex[hovered] ?? 0 : 0;
    // A chosen body system dims everything else; otherwise, when results are outside range, the healthy organs step
    // back a little so the glowing ones stand out.
    const calm = !glow && !activeSystem && Object.keys(issues).length > 0;
    const dim = activeSystem ? new Set(v.idOrgan.flatMap((o, i) => (o && !ORGAN_SYSTEMS[o]?.has(activeSystem) ? [i] : [])))
      : calm ? new Set(v.idOrgan.flatMap((o, i) => (o && o !== 'skin' && !issues[o] ? [i] : []))) : null;
    if (idMap) paintOverlay(overlay.current, idMap, hot, dim, activeSystem ? (glow ? 120 : 165) : 70);
  }, [v, idMap, hovered, activeSystem, issues, glow]);

  useEffect(() => {
    if (!issueLayer.current || !idMap) return;
    // A chosen body system takes over the highlighting.
    const levels = new Map<number, IssueLevel>(activeSystem || glow ? [] : Object.entries(issues).map(([o, lv]) => [v.organIndex[o as OrganId] ?? 0, lv as IssueLevel]));
    levels.delete(0);
    const view = m.angles[shown], areas = new Map<number, Area>();
    for (const o of Object.keys(issues) as OrganId[]) {
      const b = view.boxes[o], p = view.pins[o];
      if (b && p && (b[2] - b[0]) * (b[3] - b[1]) > SPREAD) areas.set(v.organIndex[o] ?? 0, { x: p[0], y: p[1], r: AREA_R });
    }
    paintIssues(issueLayer.current, idMap, levels, areas);
  }, [m, v, idMap, issues, activeSystem, shown, glow]);

  const organAt = async (clientX: number, clientY: number, wait: boolean): Promise<OrganId | null> => {
    const map = idMap ?? (wait ? await loadIdMap(body, shown).catch(() => null) : null);
    const el = frame.current;
    if (!map || !el) return null;
    const r = el.getBoundingClientRect();
    const x = Math.floor(((clientX - r.left) / r.width) * map.width), y = Math.floor(((clientY - r.top) / r.height) * map.height);
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
    return v.idOrgan[map.ids[y * map.width + x]] ?? null;
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

  const view = m.angles[shown];
  const box = hovered ? view.boxes[hovered] : undefined;
  const tag = hovered && box && (!labels || !PINNED_IDS.has(hovered)) && organOrNull(hovered);
  const [iw, ih] = m.idSize;
  return (
    <>
      <div ref={frame} className="bm2d__frame" role="group" tabIndex={0} aria-roledescription="body map"
        aria-label={`Body map, ${body} body, ${viewName(view.deg)} view. Left and right arrow keys turn it; organ buttons open an organ.`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onKeyDown={onKeyDown}
        onPointerCancel={() => { drag.current = null; }}
        onPointerLeave={e => { if (e.pointerType === 'mouse' && !drag.current) setHovered(null); }}
        style={{ cursor: hovered ? 'pointer' : undefined }}>
        {under !== null && under !== shown && <img className="bm2d__img" src={imageUrl(m, under, density)} alt="" draggable={false} />}
        <img key={shown} className="bm2d__img bm2d__img--in" src={imageUrl(m, shown, density)} alt="" draggable={false}
          onAnimationEnd={() => setUnder(null)} fetchPriority="high" />
        <canvas ref={issueLayer} className="bm2d__overlay bm2d__issues" width={iw} height={ih} aria-hidden />
        {glow && <><div className="bm2d__tint" aria-hidden /><div className="bm2d__veil" aria-hidden /></>}
        {glow && <Glows view={view} aspect={v.aspect} activeSystem={activeSystem} />}
        <canvas ref={overlay} className="bm2d__overlay" width={iw} height={ih} aria-hidden />
        {(labels || glow) && (
          <div className={`bm2d__pins${glow ? ' bm2d__pins--glow' : ''}`}>
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
        {tag && box && <div className="bm2d__tag" style={{ left: `${(box[0] + box[2]) * 50}%`, top: `${box[1] * 100}%` }} aria-hidden>{tag.short}</div>}
      </div>
      <div className="bm2d__turn" role="group" aria-label="Turn the body">
        <button className="bm2d__arrow" aria-label="Turn left" onClick={() => setAngle(wrap(angle + 1))}><Glyph name="left" /></button>
        <span className="bm2d__dial" aria-hidden><i style={{ transform: `rotate(${view.deg}deg)` }} /></span>
        <button className="bm2d__arrow" aria-label="Turn right" onClick={() => setAngle(wrap(angle - 1))}><Glyph name="right" /></button>
      </div>
    </>
  );
}

/** Whether the close-up camera cannot see a landmark: the render page's flag (something solid lies in front of the
 *  point), or for manifests rendered before it, the point lying well behind the view centre. */
const isHidden = (p: readonly number[]) => (p.length > 3 ? p[3] === 1 : p[2] < -0.03);

/** Name box of a close-up label: on the left of its dot (`flip`) and moved up or down by `dy` pixels. */
interface NamePlace { flip: boolean; dy: number }
type Rect = [number, number, number, number];
/** The name starts this far (px) to the right of the dot's centre, or ends this far to its left when flipped. */
const NAME_GAP = 9;

/** Places the close-up names so that none covers another name or another label's dot or runs off the frame: each name
 *  takes the first free spot, in order, beside its dot (on the left near the right edge), then on the other side,
 *  then a line or more above or below (drawn with a leader line back to its dot). Visible labels go first, so the
 *  labels of structures in view keep their plain places. `size` is [0, 0] for names the CSS hides (small screens show
 *  dots only); those only flip by position, for when a tap shows them. */
function placeNames(width: number, height: number, dots: [number, number][], size: [number, number][], order: number[]): NamePlace[] {
  const out: NamePlace[] = dots.map(([x]) => ({ flip: x > 0.68 * width, dy: 0 }));
  const taken: Rect[] = [];
  const dotRect = ([x, y]: [number, number]): Rect => [x - 7, y - 7, x + 7, y + 7];
  const area = (a: Rect, b: Rect) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  for (const i of order) {
    const [x, y] = dots[i], [w, h] = size[i];
    if (!w || !h) continue;
    const sides = x + NAME_GAP + w > width - 2 || x > 0.68 * width ? [true, false] : [false, true];
    let best: { flip: boolean; dy: number; r: Rect } | null = null, bestCost = Infinity;
    for (const step of [0, -1, 1, -2, 2, -3, 3]) {
      for (const flip of sides) {
        const dy = step * (h + 3), x0 = flip ? x - NAME_GAP - w : x + NAME_GAP, y0 = y - h / 2 + dy;
        const r: Rect = [x0 - 2, y0 - 2, x0 + w + 2, y0 + h + 2];
        let cost = (Math.max(0, -r[0]) + Math.max(0, r[2] - width) + Math.max(0, -r[1]) + Math.max(0, r[3] - height)) * h * 4;
        for (const t of taken) cost += 2 * area(r, t);
        dots.forEach((d, j) => { if (j !== i) cost += area(r, dotRect(d)); });
        cost += Math.abs(step) * 40 + (flip === sides[0] ? 0 : 20);
        if (cost < bestCost) { bestCost = cost; best = { flip, dy, r }; }
      }
    }
    if (best) { out[i] = { flip: best.flip, dy: best.dy }; taken.push(best.r); }
  }
  return out;
}

function CloseUp({ body, organ, density }: { body: Body; organ: OrganId; density: Density }) {
  const c = MANIFESTS[body].closeups[organ]!;
  const o = ORGAN_BY_ID[organ];
  const notes = new Map(o.landmarks.map(l => [l.name, l.note]));
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
  // the labels this body has a note for, in the manifest's order
  const shown = c.names.flatMap((name, i) => (c.landmarks[i] && notes.has(name) ? [{ name, p: c.landmarks[i] as readonly number[] }] : []));
  // Lay the names out once they are on screen (their sizes depend on the font and the CSS breakpoint), and again
  // whenever the frame changes size.
  const marks = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ w: number; h: number; at: NamePlace[] } | null>(null);
  const key = shown.map(m => m.name).join('|');
  useLayoutEffect(() => {
    const el = marks.current;
    if (!el) return;
    const run = () => {
      const w = el.clientWidth, h = el.clientHeight;
      const names = [...el.querySelectorAll<HTMLElement>('.landmark__name')];
      const dots = shown.map(m => [m.p[0] * w, m.p[1] * h] as [number, number]);
      const size = shown.map((_, i) => [names[i]?.offsetWidth ?? 0, names[i]?.offsetHeight ?? 0] as [number, number]);
      const order = shown.map((_, i) => i).sort((a, b) => Number(isHidden(shown[a].p)) - Number(isHidden(shown[b].p)));
      setLayout({ w, h, at: placeNames(w, h, dots, size, order) });
    };
    run();
    const ro = new ResizeObserver(run); ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names the labels; `shown` is rebuilt each render
  }, [key, ready, labels]);
  return (
    <div className="bm2d__frame bm2d__frame--close" role="group" tabIndex={0} aria-label={`${o.name}, close-up. Escape returns to the whole body.`}
      onKeyDown={e => { if (e.key === 'Escape') selectOrgan(null); }}>
      {ready ? <img className="bm2d__img bm2d__img--in" src={ready} alt="" draggable={false} /> : <div className="stage-loading bm2d__wait">Opening {o.short}…</div>}
      {labels && ready && (
        <div ref={marks} className="bm2d__marks">
          {layout && (
            <svg className="bm2d__leaders" width={layout.w} height={layout.h} aria-hidden>
              {shown.map(({ name, p }, i) => {
                const at = layout.at[i];
                if (!at?.dy) return null;
                const x = p[0] * layout.w, y = p[1] * layout.h;
                return <line key={name} className={isHidden(p) ? 'is-back' : undefined} x1={x} y1={y} x2={x + (at.flip ? -NAME_GAP : NAME_GAP)} y2={y + at.dy} />;
              })}
            </svg>
          )}
          {shown.map(({ name, p }, i) => {
            const at = layout?.at[i] ?? { flip: p[0] > 0.68, dy: 0 };
            return (
              <div key={name} className={`bm2d__mark${isHidden(p) ? ' is-back' : ''}`} style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%` }}>
                <div className={`landmark${at.flip ? ' is-flip' : ''}`} tabIndex={0}>
                  <span className="landmark__dot" />
                  <span className="landmark__name" style={at.dy ? { transform: `translateY(${at.dy}px)` } : undefined}>{name}</span>
                  <span className="landmark__note">{notes.get(name)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Pre-rendered body map of one body for the stage. */
export function BodyMap2D({ body }: { body: Body }) {
  const m = MANIFESTS[body];
  const root = useRef<HTMLDivElement>(null);
  const density = useDensity(root);
  const [angle, setAngle] = useState(0);
  const selected = useHealth(s => s.selectedOrgan);
  const close = selected && selected !== 'skin' && organOrNull(selected) && m.closeups[selected] ? selected : null;
  const glow = useStage(s => s.glow);

  // Once the first view is up, let the service worker keep this body's images of this size for next time (and
  // offline), without dropping the other body's (a family can have profiles of both sexes).
  useEffect(() => {
    if (!m.angles.length) return;
    const t = setTimeout(() => warmCache(bodymapFiles(body, density), allBodymapFiles()), 5000);
    return () => clearTimeout(t);
  }, [m, body, density]);

  if (!m.angles.length) return <div ref={root} className="bm2d"><div className="stage-loading bm2d__wait">The body map images are missing from this build.</div></div>;
  return (
    <div ref={root} className={`bm2d${glow && !close ? ' bm2d--glow' : ''}`} style={{ ['--ar' as string]: viewOf(body).aspect, ['--bg' as string]: m.background, background: m.background }}>
      {close ? <CloseUp key={close} body={body} organ={close} density={density} /> : <Turntable body={body} angle={angle} setAngle={setAngle} density={density} />}
    </div>
  );
}
