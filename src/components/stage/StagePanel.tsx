// The body map's visual stage and its controls. Owned separately from the side panels so each can evolve on its own.
import { lazy, Suspense } from 'react';
import { useHealth } from '../../lib/store';
import { useUI, type SectionAxis } from '../../state/ui';
import { ORGAN_BY_ID } from '../../anatomy/organs';
import { possessive, useActiveProfile } from '../../state/session';
import { Icon } from '../ui';

const Stage = lazy(() => import('../../three/Stage'));

/** The stage area of the body map: the anatomy view plus its overlay controls. */
export function StagePanel() {
  return (
    <section className="stage" aria-label="3D body model">
      <Suspense fallback={<div className="stage__title"><p>Loading the 3D model…</p></div>}><Stage /></Suspense>
      <StageOverlay />
    </section>
  );
}

function StageOverlay() {
  const selected = useHealth(s => s.selectedOrgan), selectOrgan = useHealth(s => s.selectOrgan);
  const { layers, toggleLayer, quality, setQuality } = useUI();
  const organ = selected ? ORGAN_BY_ID[selected] : null;
  const profile = useActiveProfile();
  return (
    <>
      <div className="stage__title">
        <h2>{organ ? organ.name : `${possessive(profile)} body, mapped`}</h2>
        <p>{organ ? 'Drag to turn, scroll to move closer, and hover a point to read about it.' : 'Click an organ to open it. Dots show where your results relate.'}</p>
      </div>
      <div className="stage__tools" role="group" aria-label="Model layers">
        {!organ && <button className="chip" aria-pressed={layers.skin} onClick={() => toggleLayer('skin')}>Skin</button>}
        {(!organ || organ.id === 'marrow') && <button className="chip" aria-pressed={layers.skeleton} onClick={() => toggleLayer('skeleton')}>Skeleton</button>}
        <button className="chip" aria-pressed={layers.labels} onClick={() => toggleLayer('labels')}>Labels</button>
        <button className="chip" aria-pressed={quality === 'high'} onClick={() => setQuality(quality === 'high' ? 'fast' : 'high')} title="Soft shadows and water reflections">Studio light</button>
      </div>
      {organ ? (
        <button className="btn stage__back" onClick={() => selectOrgan(null)}>{Icon.back} Whole body</button>
      ) : (
        <div className="stage__legend" aria-hidden>
          <span><i style={{ background: '#5fbf95' }} />All in range</span>
          <span><i style={{ background: '#e9b949' }} />Some outside range</span>
          <span><i style={{ background: '#7f9b98' }} />No results yet</span>
        </div>
      )}
      <div className="stage__hint">Double-click empty water to reset</div>
    </>
  );
}

/** X-ray and cross-section controls, shown in the organ panel. */
export function SectionControls() {
  const { xray, setXray, section, setSection } = useUI();
  const axes: { id: SectionAxis; label: string }[] = [{ id: 'coronal', label: 'Front' }, { id: 'sagittal', label: 'Side' }, { id: 'transverse', label: 'Top' }];
  return (
    <div className="section">
      <h3>Look inside</h3>
      <div className="tools">
        <button className="toggle" aria-pressed={xray} onClick={() => setXray(!xray)}><i />X-ray</button>
        <button className="toggle" aria-pressed={section.on} onClick={() => setSection({ on: !section.on })}><i />Cross-section</button>
        {section.on && (
          <div className="seg" role="group" aria-label="Cutting plane">
            {axes.map(a => <button key={a.id} aria-pressed={section.axis === a.id} onClick={() => setSection({ axis: a.id })}>{a.label}</button>)}
          </div>
        )}
      </div>
      {section.on && (
        <label style={{ display: 'block', marginTop: 12 }}>
          <span className="note">Cut depth</span>
          <input className="slider" type="range" min={0} max={0.95} step={0.01} value={section.depth} onChange={e => setSection({ depth: +e.target.value })} />
        </label>
      )}
    </div>
  );
}
