// Side panel of the body map: welcome, overview and organ details.
import { useEffect, useState, type ReactNode } from 'react';
import { useHealth } from '../../lib/store';
import { useUI } from '../../state/ui';
import { ORGAN_BY_ID, organOrNull } from '../../anatomy/organs';
import { landmarksOf } from '../../anatomy/bodies';
import { useBody } from '../../state/body';
import { formatDate, seriesForOrgan, type Series } from '../../lib/derive';
import { Icon, SegBar, StatusChip, StatusRing } from '../ui';
import { ArrowIcon, ModalityBadge, SystemIcon, UiIcon } from '../icons';
import type { OrganId, ScanItem, Status } from '../../types';
import { errorMessage, isPreview } from '../../api';
import { firstName, useActiveProfile } from '../../state/session';
import { toast } from '../../state/toast';
import { findLegacyData, legacyAsResult, markLegacyHandled } from '../../lib/legacy';
import { SectionControls } from '../stage/StagePanel';
import { MarkerCard } from './MarkerCard';
import {
  groupBySystem, groupStatus, needsAttention, openLabs, sampleDates, showMarkers, statusCounts, systemLabel, type StatusCounts,
} from './summary';

type Legacy = Awaited<ReturnType<typeof findLegacyData>>;

/** Offer to bring in results saved by the earlier, browser-only version. */
function LegacyImport() {
  const addResult = useHealth(s => s.addResult);
  const profile = useActiveProfile();
  const [legacy, setLegacy] = useState<Legacy>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let alive = true; void findLegacyData().then(d => { if (alive) setLegacy(d); }); return () => { alive = false; }; }, []);
  if (!legacy) return null;
  const n = legacy.measurements.length, k = legacy.scans.length;
  return (
    <div className="callout legacy">
      <p className="legacy__title"><UiIcon name="layers" /><b>Results from the earlier version of LotusPond</b></p>
      <p className="note">This browser holds {n} result{n === 1 ? '' : 's'}{k ? ` and ${k} scan${k === 1 ? '' : 's'}` : ''} saved before accounts existed. Import them into {profile?.relationship === 'self' ? 'your' : `${firstName(profile)}’s`} records?</p>
      <div className="tools">
        <button className="btn btn--primary" disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            const done = await addResult(await legacyAsResult(legacy), []);
            await markLegacyHandled();
            setLegacy(null);
            toast.info(`Imported ${done.measurements} results${done.scans ? ` and ${done.scans} scans` : ''}.`);
          } catch (e) { toast.error(errorMessage(e)); setBusy(false); }
        }}>{busy ? 'Importing…' : 'Import'}</button>
        <button className="btn btn--quiet" disabled={busy} onClick={() => { void markLegacyHandled(); setLegacy(null); }}>Not now</button>
      </div>
    </div>
  );
}

/* ---------------- first run ---------------- */

/** A report's rows flowing onto the body: the idea of the app in one picture. */
function WelcomeArt() {
  return (
    <svg className="wl-art" viewBox="0 0 340 128" role="img" aria-label="Rows from a lab report linked to organs on a body outline">
      <rect className="wl-art__paper" x="14" y="12" width="118" height="104" rx="12" />
      <rect className="wl-art__head" x="30" y="28" width="56" height="7" rx="3.5" />
      {[52, 72, 92].map((y, i) => (
        <g key={y}>
          <circle className={`dot--${i === 1 ? 'high' : 'normal'}`} cx="36" cy={y} r="5" />
          <rect className="wl-art__row" x="48" y={y - 3} width={i === 1 ? 46 : 58} height="6" rx="3" />
          <rect className="wl-art__val" x="100" y={y - 3} width="18" height="6" rx="3" />
        </g>
      ))}
      <path className="wl-art__link" d="M124 52 C 176 52, 200 56, 249 56" />
      <path className="wl-art__link" d="M124 72 C 180 72, 208 70, 261 70" />
      <circle className="wl-art__pond" cx="262" cy="64" r="54" />
      <g className="wl-art__body" transform="translate(262 64)">
        <circle cx="0" cy="-36" r="8" />
        <path d="M-15 -22h30l9 30-10 3 3 33h-12l-3-24h-4l-3 24h-12l3-33-10-3z" />
      </g>
      <circle className="dot--normal wl-art__pin" cx="255" cy="56" r="5.5" />
      <circle className="dot--high wl-art__pin" cx="267" cy="70" r="5.5" />
    </svg>
  );
}

const STEPS: { icon: ReactNode; title: string; text: string }[] = [
  { icon: Icon.upload, title: 'Upload', text: 'Lab report PDFs, CSV exports, scan photos or DICOM files' },
  { icon: Icon.check, title: 'Check', text: 'Review what was read and fix anything that looks off' },
  { icon: Icon.body, title: 'Explore', text: 'Open an organ for its results, trends and anatomy' },
];

function Welcome() {
  const loadSample = useHealth(s => s.loadSample);
  const setUploadOpen = useUI(s => s.setUploadOpen);
  const profile = useActiveProfile();
  const [busy, setBusy] = useState(false);
  const isSelf = profile?.relationship === 'self';
  const self = !isSelf ? `${firstName(profile)}’s` : 'your';
  return (
    <div className="welcome">
      <LegacyImport />
      <WelcomeArt />
      <h2>{isSelf ? 'See your results where they happen' : `Start ${self} record`}</h2>
      <p className="lede">Each result lands on the organ it relates to, so you can explore {isSelf ? 'your body' : `${self} health`} one system at a time.</p>
      <ol className="wl-steps">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <span className="wl-steps__icon" aria-hidden>{s.icon}<em>{i + 1}</em></span>
            <span><b>{s.title}</b><span>{s.text}</span></span>
          </li>
        ))}
      </ol>
      <div className="actions">
        <button className="btn btn--primary" onClick={() => setUploadOpen(true)}>{Icon.upload} Upload results</button>
        <button className="btn" disabled={busy} onClick={async () => {
          setBusy(true);
          try { await loadSample(); toast.info('Sample results added. Delete them any time from the profile page.'); }
          catch (e) { toast.error(errorMessage(e)); }
          finally { setBusy(false); }
        }}>{busy ? 'Adding sample…' : 'Explore with sample data'}</button>
      </div>
      <p className="wl-privacy">{Icon.lock}<span>{isPreview
        ? 'Files are read on this device and saved in this browser only. LotusPond explains results; it does not diagnose.'
        : 'Files are read on this device and saved to your account with their originals. LotusPond explains results; it does not diagnose.'}</span></p>
    </div>
  );
}

/* ---------------- overview ---------------- */

const LEGEND: Status[] = ['normal', 'high', 'low', 'unknown'];
const LEGEND_WORD: Record<Status, string> = { normal: 'In range', high: 'Above range', low: 'Below range', unknown: 'No range' };

function CountFlags({ c }: { c: StatusCounts }) {
  if (!c.high && !c.low) {
    return c.normal ? <span className="flags"><span className="flags__ok">{Icon.check} All in range</span></span> : <span className="flags">No ranges</span>;
  }
  return (
    <span className="flags">
      {c.high > 0 && <span className="flag flag--high" title={`${c.high} above range`}><ArrowIcon dir="up" />{c.high}<span className="sr-only"> above range</span></span>}
      {c.low > 0 && <span className="flag flag--low" title={`${c.low} below range`}><ArrowIcon dir="down" />{c.low}<span className="sr-only"> below range</span></span>}
    </span>
  );
}

function ScanStrip({ scans, limit }: { scans: ScanItem[]; limit?: number }) {
  const setScanOpen = useUI(s => s.setScanOpen);
  const list = [...scans].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, limit);
  return (
    <ul className="scan-strip">
      {list.map(s => (
        <li key={s.id}>
          <button className="thumb" onClick={() => setScanOpen(s.id)} aria-label={`Open scan ${s.fileName}${s.date ? `, ${formatDate(s.date)}` : ''}`}>
            <img src={s.thumbDataUrl} alt="" /><ModalityBadge modality={s.modality} />
          </button>
          <span className="scan-strip__date">{s.date ? formatDate(s.date, { day: 'numeric', month: 'short' }) : s.bodyPart ?? 'Undated'}</span>
        </li>
      ))}
    </ul>
  );
}

const ATTENTION_FIRST = 4;

function Overview({ series }: { series: Series[] }) {
  const scans = useHealth(s => s.scans);
  const setUploadOpen = useUI(s => s.setUploadOpen);
  const setView = useUI(s => s.setView);
  const [showAll, setShowAll] = useState(false);
  const counts = statusCounts(series);
  const attention = needsAttention(series);
  const groups = groupBySystem(series);
  const dates = sampleDates(series);
  const latest = dates[dates.length - 1];
  const shown = showAll ? attention : attention.slice(0, ATTENTION_FIRST);
  const ringLabel = `${counts.total} markers tracked: ${LEGEND.filter(s => counts[s]).map(s => `${counts[s]} ${LEGEND_WORD[s].toLowerCase()}`).join(', ')}.`;
  return (
    <>
      <div className="section ov-head">
        <h2>Overview</h2>
        <div className="ichips">
          <span className="ichip ichip--strong"><UiIcon name="calendar" size={15} />{latest ? `Latest report ${formatDate(latest)}` : 'Results without dates'}</span>
          {dates.length > 1 && <span className="ichip"><UiIcon name="layers" size={15} />{dates.length} report dates</span>}
          {scans.length > 0 && <span className="ichip"><UiIcon name="scan" size={15} />{scans.length} scan{scans.length > 1 ? 's' : ''}</span>}
        </div>
      </div>

      <div className="section tally ov-ring">
        <StatusRing counts={counts} label={ringLabel}>
          <b>{counts.total}</b><span>markers tracked</span>
        </StatusRing>
        <ul className="ov-legend" aria-label="Latest results by status">
          {LEGEND.filter(s => s !== 'unknown' || counts.unknown).map(s => (
            <li key={s}><i className={`swatch dot--${s}`} aria-hidden /><span>{LEGEND_WORD[s]}</span><b>{counts[s]}</b></li>
          ))}
        </ul>
      </div>

      <div className="section ov-actions">
        <button className="btn btn--primary" onClick={() => setUploadOpen(true)}>{Icon.upload} Upload results</button>
        <button className="btn" onClick={() => { if (!openLabs()) toast.info('Finding a nearby lab is not available yet.'); }}><UiIcon name="pin" size={16} /> Find a lab</button>
        <button className="btn btn--quiet" onClick={() => showMarkers('all')}><UiIcon name="grid" size={16} /> All results</button>
      </div>

      <div className="section">
        <h3>Needs attention <small>{attention.length ? `${attention.length} outside range` : ''}</small></h3>
        {attention.length ? (
          <>
            <div className="mlist">{shown.map(s => <MarkerCard key={s.key} s={s} />)}</div>
            {attention.length > ATTENTION_FIRST && (
              <button className="btn btn--quiet ov-more" aria-expanded={showAll} onClick={() => setShowAll(v => !v)}>
                {showAll ? 'Show fewer' : `Show ${attention.length - ATTENTION_FIRST} more`}<span className={`chev${showAll ? ' chev--up' : ''}`}>{Icon.chevron}</span>
              </button>
            )}
          </>
        ) : <p className="ov-allgood">{Icon.check}<span>Every latest result is within its range.</span></p>}
      </div>

      <div className="section">
        <h3>Body systems <small>{groups.filter(g => g.system !== 'other').length} with results</small></h3>
        <div className="systiles">
          {groups.map(g => {
            const st = groupStatus(g.counts);
            return (
              <button key={g.system} className={`systile systile--${st}`} onClick={() => showMarkers(g.system)}
                aria-label={`${systemLabel(g.system)}: ${g.counts.total} markers${g.counts.high ? `, ${g.counts.high} above range` : ''}${g.counts.low ? `, ${g.counts.low} below range` : ''}${!g.counts.high && !g.counts.low && g.counts.normal ? ', all in range' : ''}`}>
                <span className="systile__icon"><SystemIcon system={g.system} size={20} /></span>
                <span className="systile__name">{systemLabel(g.system)}</span>
                <span className="systile__meta"><span>{g.counts.total} marker{g.counts.total > 1 ? 's' : ''}</span><CountFlags c={g.counts} /></span>
                <SegBar counts={g.counts} />
              </button>
            );
          })}
        </div>
      </div>

      {scans.length > 0 && (
        <div className="section">
          <h3>Recent scans <button className="linkish" onClick={() => setView('scans')}>See all</button></h3>
          <ScanStrip scans={scans} limit={4} />
        </div>
      )}

      <div className="section"><p className="note">Ranges come from your report when it lists one; otherwise a typical adult range is used and marked as such. LotusPond explains results; it does not diagnose. Discuss results with a clinician before acting on them.</p></div>
    </>
  );
}

/* ---------------- organ ---------------- */

function OrganPanel({ organ, series }: { organ: OrganId; series: Series[] }) {
  const o = ORGAN_BY_ID[organ];
  const body = useBody();
  const marks = landmarksOf(body, organ);
  const list = seriesForOrgan(series, organ);
  const scans = useHealth(s => s.scans).filter(s => s.organ === organ);
  const c = statusCounts(list);
  return (
    <>
      <div className="section org-head">
        <h2>{o.name}</h2>
        <div className="ichips" aria-label="Summary">
          {c.high > 0 && <StatusChip status="high" label={`${c.high} above range`} />}
          {c.low > 0 && <StatusChip status="low" label={`${c.low} below range`} />}
          {c.normal > 0 && <StatusChip status="normal" label={`${c.normal} in range`} />}
          {c.unknown > 0 && <StatusChip status="unknown" label={`${c.unknown} no range`} />}
          {!list.length && <span className="ichip">No results yet</span>}
          {scans.length > 0 && <span className="ichip"><UiIcon name="scan" size={15} />{scans.length} scan{scans.length > 1 ? 's' : ''}</span>}
        </div>
        <p className="lede">{o.summary}</p>
      </div>
      {o.facts.length > 0 && (
        <div className="section">
          <dl className="org-facts">{o.facts.map(f => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>
        </div>
      )}
      <SectionControls />
      <div className="section">
        <h3>Related results <small>{list.length ? `${list.length} marker${list.length > 1 ? 's' : ''}` : ''}</small></h3>
        {list.length
          ? <div className="mgrid mgrid--compact">{list.map(s => <MarkerCard key={s.key} s={s} compact />)}</div>
          : <p className="note">None of the uploaded results relate to this organ yet.</p>}
      </div>
      <div className="section">
        <h3>Scans <small>{scans.length || ''}</small></h3>
        {scans.length ? <ScanStrip scans={scans} /> : <p className="note">Attach a scan of this area from the Scans page or while uploading.</p>}
      </div>
      <div className="section">
        <details className="org-landmarks">
          <summary><span>Anatomy in this view</span><small>{marks.length} landmark{marks.length === 1 ? '' : 's'}</small><span className="chev">{Icon.chevron}</span></summary>
          <ul>{marks.map(l => <li key={l.name}><b>{l.name}</b><span>{l.note}</span></li>)}</ul>
        </details>
      </div>
    </>
  );
}

/** What the side panel shows: an organ, the overview, or the first-run welcome. */
export function ContextPanel({ series }: { series: Series[] }) {
  const selected = useHealth(s => s.selectedOrgan);
  const loading = useHealth(s => s.loading);
  if (loading) return <p className="note loading-note" role="status">Loading records…</p>;
  // an organ id this version does not know (sent by a newer app) falls back to the overview
  if (selected && organOrNull(selected)) return <OrganPanel organ={selected} series={series} />;
  return series.length ? <Overview series={series} /> : <Welcome />;
}
