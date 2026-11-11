// The body map's visual stage and its controls. Owned separately from the side panels so each can evolve on its own.
// Default view: the pre-rendered body map (no WebGL). "Explore in 3D" loads three.js and the model on first use.
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useHealth } from '../../lib/store';
import { useUI, type SectionAxis } from '../../state/ui';
import { ORGAN_BY_ID } from '../../anatomy/organs';
import { possessive, useActiveProfile } from '../../state/session';
import { Icon } from '../ui';
import { BodyMap2D } from '../bodymap2d/BodyMap2D';
import { Glyph, type GlyphName } from './Glyph';
import { STATUS_COLOR } from './status';
import { ISSUE_COLOR, useIssues } from './issues';
import { useStage, type StageMode } from './stageSettings';
import '../../styles/stage.css';

// Loaded only when the 3D view is first chosen (it also starts the model download).
const Stage = lazy(() => import('../../three/Stage'));

/** False while the stage cannot be seen: another page, signed out (hidden shell), scrolled away, or a background tab. */
function useSeen(ref: RefObject<HTMLElement | null>) {
  const [onScreen, setOnScreen] = useState(true);
  const [tab, setTab] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  useEffect(() => {
    const f = () => setTab(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, []);
  return onScreen && tab;
}

/** The stage area of the body map: the anatomy view plus its overlay controls. */
export function StagePanel() {
  const mode = useStage(s => s.mode), tier = useStage(s => s.tier);
  const ref = useRef<HTMLElement>(null);
  const seen = useSeen(ref);
  // Once opened, the 3D stage stays mounted (paused while hidden): switching back is instant, and the WebGL
  // teardown path is avoided (see App.tsx).
  const [opened3d, setOpened3d] = useState(mode === '3d');
  if (mode === '3d' && !opened3d) setOpened3d(true);
  return (
    <section ref={ref} className={`stage stage--${mode}`} aria-label="Body map">
      {mode === 'map' && <BodyMap2D />}
      {opened3d && (
        <div className="stage3d" data-off={mode !== '3d' || undefined} data-tier={tier} aria-hidden={mode !== '3d' || undefined}>
          <Suspense fallback={<div className="stage-loading stage3d__wait">Loading the 3D model…</div>}>
            <Stage active={mode === '3d' && seen} />
          </Suspense>
        </div>
      )}
      <StageOverlay mode={mode} />
    </section>
  );
}

function Chip({ on, onClick, icon, label, title, extra }: { on: boolean; onClick: () => void; icon: GlyphName; label: string; title?: string; extra?: ReactNode }) {
  return (
    <button className="chip chip--icon" aria-pressed={on} onClick={onClick} title={title ?? label} aria-label={label}>
      <Glyph name={icon} />{extra}
    </button>
  );
}

function ModeSwitch({ mode }: { mode: StageMode }) {
  const setMode = useStage(s => s.setMode);
  return (
    <div className="modes" role="group" aria-label="View">
      <button aria-pressed={mode === 'map'} onClick={() => setMode('map')} aria-label="Body map"><Glyph name="map" /><span>Body map</span></button>
      <button aria-pressed={mode === '3d'} onClick={() => setMode('3d')} aria-label="Explore in 3D"><Glyph name="cube" /><span><span className="modes__long">Explore in </span>3D</span></button>
    </div>
  );
}

function StageOverlay({ mode }: { mode: StageMode }) {
  const selected = useHealth(s => s.selectedOrgan), selectOrgan = useHealth(s => s.selectOrgan);
  const { layers, toggleLayer } = useUI();
  const studio = useStage(s => s.studio), tier = useStage(s => s.tier), setStudio = useStage(s => s.setStudio);
  const organ = selected && selected !== 'skin' ? ORGAN_BY_ID[selected] : null;
  const profile = useActiveProfile();
  const in3d = mode === '3d';
  const held = studio && tier < 3;
  return (
    <>
      <div className="stage__title">
        <h2>{organ ? organ.name : `${possessive(profile)} body, mapped`}</h2>
      </div>
      <div className="stage__tools">
        <ModeSwitch mode={mode} />
        <div className="stage__chips" role="group" aria-label="Show on the model">
          {in3d && !organ && <Chip on={layers.skin} onClick={() => toggleLayer('skin')} icon="skin" label="Skin" />}
          {in3d && (!organ || organ.id === 'marrow') && <Chip on={layers.skeleton} onClick={() => toggleLayer('skeleton')} icon="bone" label="Skeleton" />}
          <Chip on={layers.labels} onClick={() => toggleLayer('labels')} icon="tag" label="Labels" title="Result dots and labels" />
          {in3d && <Chip on={studio} onClick={() => setStudio(!studio)} icon="sun" label="Studio light"
            title={held ? 'Studio light: paused to keep this device smooth' : 'Studio light: water reflections and glow'} extra={held ? <i className="chip__held" /> : null} />}
        </div>
      </div>
      {organ ? (
        <button className="btn stage__back" onClick={() => selectOrgan(null)}>{Icon.back} Whole body</button>
      ) : (
        <IssueLegend />
      )}
      <div className="stage__hint" aria-hidden>
        {in3d
          ? <><Glyph name="orbit" /><span>drag</span><Glyph name="zoom" /><span>scroll</span>{!organ && <><Glyph name="reset" /><span>double-click</span></>}</>
          : organ ? <><Glyph name="tap" /><span>details</span></> : <><Glyph name="drag" /><span>turn</span><Glyph name="tap" /><span>open</span></>}
      </div>
    </>
  );
}

/** What the glow on the body means; only shown when something glows. */
function IssueLegend() {
  const { organs } = useIssues();
  const levels = new Set(Object.values(organs));
  if (!levels.size) return <div className="stage__legend" aria-hidden><span><i style={{ background: STATUS_COLOR.ok }} />Nothing outside range</span></div>;
  return (
    <div className="stage__legend" aria-hidden>
      <span><i className="glow" style={{ background: ISSUE_COLOR.out }} />Outside range</span>
      {levels.has('far') && <span><i className="glow" style={{ background: ISSUE_COLOR.far }} />Far outside</span>}
    </div>
  );
}

/** X-ray and cross-section controls, shown in the organ panel. They need the 3D view, which they switch to. */
export function SectionControls() {
  const { xray, setXray, section, setSection } = useUI();
  const mode = useStage(s => s.mode), setMode = useStage(s => s.setMode);
  const axes: { id: SectionAxis; label: string }[] = [{ id: 'coronal', label: 'Front' }, { id: 'sagittal', label: 'Side' }, { id: 'transverse', label: 'Top' }];
  const in3d = mode === '3d';
  const to3d = () => { if (!in3d) setMode('3d'); };
  return (
    <div className="section">
      <h3>Look inside {!in3d && <small>opens 3D</small>}</h3>
      <div className="tools">
        <button className="toggle" aria-pressed={in3d && xray} onClick={() => { to3d(); setXray(in3d ? !xray : true); }}><i />X-ray</button>
        <button className="toggle" aria-pressed={in3d && section.on} onClick={() => { to3d(); setSection({ on: in3d ? !section.on : true }); }}><i />Cross-section</button>
        {in3d && section.on && (
          <div className="seg" role="group" aria-label="Cutting plane">
            {axes.map(a => <button key={a.id} aria-pressed={section.axis === a.id} onClick={() => setSection({ axis: a.id })}>{a.label}</button>)}
          </div>
        )}
      </div>
      {in3d && section.on && (
        <label style={{ display: 'block', marginTop: 12 }}>
          <span className="note">Cut depth</span>
          <input className="slider" type="range" min={0} max={0.95} step={0.01} value={section.depth} onChange={e => setSection({ depth: +e.target.value })} />
        </label>
      )}
    </div>
  );
}
