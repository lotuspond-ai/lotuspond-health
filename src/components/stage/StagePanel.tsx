// The body map's visual stage and its controls. Owned separately from the side panels so each can evolve on its own.
// A simple, pre-rendered body map (images, no WebGL): where results sit and which ones need a look.
import type { ReactNode } from 'react';
import { useHealth } from '../../lib/store';
import { useUI } from '../../state/ui';
import { ORGAN_BY_ID } from '../../anatomy/organs';
import { possessive, useActiveProfile } from '../../state/session';
import { Icon } from '../ui';
import { BodyMap2D } from '../bodymap2d/BodyMap2D';
import { Glyph, type GlyphName } from './Glyph';
import { STATUS_COLOR } from './status';
import { ISSUE_COLOR, useIssues } from './issues';
import { useStage } from './stageSettings';
import { GRADE_COLOR, gradeText, useSystemGrades } from './grades';
import '../../styles/stage.css';

/** The stage area of the body map: the map plus its overlay controls. */
export function StagePanel() {
  return (
    <section className="stage stage--map" aria-label="Body map">
      <BodyMap2D />
      <StageOverlay />
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

function StageOverlay() {
  const selected = useHealth(s => s.selectedOrgan), selectOrgan = useHealth(s => s.selectOrgan);
  const { layers, toggleLayer } = useUI();
  const glow = useStage(s => s.glow), setGlow = useStage(s => s.setGlow);
  const organ = selected && selected !== 'skin' ? ORGAN_BY_ID[selected] : null;
  const profile = useActiveProfile();
  return (
    <>
      <div className="stage__title">
        <h2>{organ ? organ.name : `${possessive(profile)} body, mapped`}</h2>
      </div>
      <div className="stage__tools">
        <div className="stage__chips" role="group" aria-label="Show on the map">
          {!organ && <Chip on={glow} onClick={() => setGlow(!glow)} icon="glow" label="Glow view" title="Glow view: soft halos and a grade per body system" />}
          {!(glow && !organ) && <Chip on={layers.labels} onClick={() => toggleLayer('labels')} icon="tag" label="Labels" title="Result dots and labels" />}
        </div>
      </div>
      {organ ? (
        <button className="btn stage__back" onClick={() => selectOrgan(null)}>{Icon.back} Whole body</button>
      ) : glow ? (
        <SystemGrades />
      ) : (
        <IssueLegend />
      )}
      <div className="stage__hint" aria-hidden>
        {organ ? <><Glyph name="tap" /><span>details</span></> : <><Glyph name="drag" /><span>turn</span><Glyph name="tap" /><span>open</span></>}
      </div>
    </>
  );
}

/** A ring and a letter per body system, beside the body in the glow view. Choosing one shows only its organs. */
function SystemGrades() {
  const grades = useSystemGrades();
  // Before any results, the rings all read "–" and nothing glows, so the keys are left out.
  const any = grades.some(g => g.total > 0);
  const active = useHealth(s => s.activeSystem), setActive = useHealth(s => s.setActiveSystem);
  return (
    <>
    <nav className="grades" aria-label="Body systems">
      <ul>
        {grades.map(g => {
          const c = GRADE_COLOR[g.grade];
          // The ring fills with the share of results in range.
          const share = g.total ? (g.total - g.out) / g.total : 0;
          return (
            <li key={g.system}>
              <button className={`grade${g.total ? '' : ' is-empty'}`} aria-pressed={active === g.system} title={gradeText(g)} aria-label={gradeText(g)}
                onClick={() => setActive(active === g.system ? null : g.system)} style={{ ['--grade' as string]: c }}>
                <span className="grade__ring" aria-hidden>
                  <svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.5" className="grade__track" />
                    {g.total > 0 && <circle cx="18" cy="18" r="15.5" className="grade__fill" pathLength={100} strokeDasharray={`${Math.max(share * 100, 6)} 100`} />}</svg>
                  <b>{g.grade}</b>
                </span>
                <span className="grade__name">{g.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {any && <p className="grades__key">A all in range · B some outside<br />C some far outside</p>}
    </nav>
    {any && <GlowLegend />}
    </>
  );
}

/** Key for the glow view: halo colours and what the letters mean. */
function GlowLegend() {
  return (
    <div className="stage__legend stage__legend--glow" aria-hidden>
      <span><i className="halo" style={{ ['--c' as string]: GRADE_COLOR.A }} />In range</span>
      <span><i className="halo" style={{ ['--c' as string]: GRADE_COLOR.B }} />Outside range</span>
      <span><i className="halo" style={{ ['--c' as string]: GRADE_COLOR.C }} />Far outside</span>
    </div>
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
