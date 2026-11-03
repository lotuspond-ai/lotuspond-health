// The body map's visual stage and its controls. Owned separately from the side panels so each can evolve on its own.
// Default view: the pre-rendered body map (no WebGL). "Explore in 3D" loads three.js and the model on first use.
import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useHealth } from '../../lib/store';
import { useUI, type SectionAxis } from '../../state/ui';
import { organOrNull } from '../../anatomy/organs';
import { possessive, useActiveProfile } from '../../state/session';
import { useBody } from '../../state/body';
import type { Body } from '../../lib/body';
import { siteHref, siteLinkProps } from '../../site/links';
import { Icon } from '../ui';
import { BodyMap2D } from '../bodymap2d/BodyMap2D';
import { Glyph, type GlyphName } from './Glyph';
import { STATUS_COLOR } from './status';
import { useStage, type StageMode } from './stageSettings';
import '../../styles/stage.css';

// Loaded only when the 3D view is first chosen (it also starts the model download).
const loadStage = () => import('../../three/Stage');

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

/** A failed download of the 3D code itself (not the model). Browsers keep a failed module import for the life of the
 *  page, so only a reload can fetch it again. Messages from Chromium, Firefox, Safari and Vite's preloader. */
const codeFailed = (e: unknown) => /dynamically imported module|Importing a module script failed|Unable to preload/i.test(String((e as Error)?.message ?? e));

/** Catches a failed model or 3D-code download (offline, interrupted) and offers to try again. */
class StageBoundary extends Component<{ body: Body; onRetry: () => void; children: ReactNode }, { failed: boolean; code: boolean; body: Body }> {
  state = { failed: false, code: false, body: this.props.body };
  static getDerivedStateFromError(e: unknown) { return { failed: true, code: codeFailed(e) }; }
  // another body is another download: try it even if the last one failed
  static getDerivedStateFromProps(props: { body: Body }, state: { body: Body }) { return props.body !== state.body ? { failed: false, body: props.body } : null; }
  retry = () => {
    if (this.state.code) { location.reload(); return; }
    // forget the failed model download (the loader caches errors) and the failed 3D code, then render again
    import('../../three/model').then(m => m.clearAnatomyModel(this.props.body)).catch(() => {})
      .finally(() => { this.props.onRetry(); this.setState({ failed: false }); });
  };
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="stage-loading stage3d__wait" role="alert">
        The 3D model could not be loaded. <button className="btn" onClick={this.retry}>Try again</button>
      </div>
    );
  }
}

/** The stage area of the body map: the anatomy view plus its overlay controls. */
export function StagePanel() {
  const mode = useStage(s => s.mode), tier = useStage(s => s.tier);
  const ref = useRef<HTMLElement>(null);
  const seen = useSeen(ref);
  const body = useBody();
  // Once opened, the 3D stage stays mounted (paused while hidden): switching back is instant, and the WebGL
  // teardown path is avoided (see App.tsx). It changes body only while shown, so switching profiles in the 2D view
  // does not download the other model in the background.
  // React.lazy keeps a failed import, so "Try again" needs a new lazy component as well as a new download
  const [Stage, setStage] = useState(() => lazy(loadStage));
  const [opened3d, setOpened3d] = useState(mode === '3d');
  const [body3d, setBody3d] = useState(body);
  if (mode === '3d' && !opened3d) setOpened3d(true);
  if (mode === '3d' && body3d !== body) setBody3d(body);
  return (
    <section ref={ref} className={`stage stage--${mode}`} aria-label="Body map" data-body={body}>
      {mode === 'map' && <BodyMap2D key={body} body={body} />}
      {opened3d && (
        <div className="stage3d" data-off={mode !== '3d' || undefined} data-tier={tier} aria-hidden={mode !== '3d' || undefined}>
          <StageBoundary body={body3d} onRetry={() => setStage(() => lazy(loadStage))}>
            <Suspense fallback={<div className="stage-loading stage3d__wait">Loading the 3D model…</div>}>
              <Stage active={mode === '3d' && seen} body={body3d} />
            </Suspense>
          </StageBoundary>
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
  const organ = selected && selected !== 'skin' ? organOrNull(selected) : null;
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
        <div className="stage__legend" aria-hidden>
          <span><i style={{ background: STATUS_COLOR.ok }} />In range</span>
          <span><i style={{ background: STATUS_COLOR.out }} />Outside</span>
          <span><i style={{ background: STATUS_COLOR.none }} />No results</span>
        </div>
      )}
      <p className="stage__credit">
        <a href={siteHref('/credits/')} {...siteLinkProps}><span className="stage__credit-long">Anatomy: HuBMAP Human Reference Atlas and Z-Anatomy, CC BY-SA 4.0</span><span className="stage__credit-short">Anatomy credits</span></a>
      </p>
      <div className="stage__hint" aria-hidden>
        {in3d
          ? <><Glyph name="orbit" /><span>drag</span><Glyph name="zoom" /><span>scroll</span>{!organ && <><Glyph name="reset" /><span>double-click</span></>}</>
          : organ ? <><Glyph name="tap" /><span>details</span></> : <><Glyph name="drag" /><span>turn</span><Glyph name="tap" /><span>open</span></>}
      </div>
    </>
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
