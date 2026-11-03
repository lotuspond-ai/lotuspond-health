import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useHealth, getScanBlob } from '../lib/store';
import { parseFile } from '../lib/parse';
import { renderDicom } from '../lib/parse/dicom';
import { BIOMARKERS, SYSTEM_LABELS } from '../lib/catalog';
import { ORGAN_BY_ID } from '../anatomy/organs';
import { buildSeries, formatDate } from '../lib/derive';
import { useUI } from '../state/ui';
import { Icon, RangeBar, StatusChip, TrendChart } from './ui';
import { ArrowIcon, ModalityBadge, SystemIcon, UiIcon } from './icons';
import { rangeText } from './context/summary';
import { displayMeasurement, roundForDisplay } from '../lib/units';
import { OrganSelect } from '../pages/Scans';
import { errorMessage, isPreview } from '../api';
import { firstName, useActiveProfile, useUnitSystem } from '../state/session';
import { toast } from '../state/toast';
import type { Measurement, ParseResult } from '../types';

/** Close on Escape. Subscribes once and always calls the latest `close`, so there is no gap while effects re-run. */
function useEscape(close: () => void) {
  const latest = useRef(close);
  useLayoutEffect(() => { latest.current = close; });
  useLayoutEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') latest.current(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
}

/* ---------- marker detail ---------- */
function Delta({ points }: { points: Measurement[] }) {
  const system = useUnitSystem();
  const vals = points.map(p => ({ p, d: displayMeasurement(p, system) })).filter(x => x.d.value != null);
  if (vals.length < 2) return null;
  const a = vals[vals.length - 2], b = vals[vals.length - 1];
  if (a.d.unit !== b.d.unit) return null;
  const diff = roundForDisplay(b.d.value! - a.d.value!);
  const since = a.p.date ? `since ${formatDate(a.p.date)}` : 'since the previous result';
  if (diff === 0) return <span className="ichip">No change {since}</span>;
  return (
    <span className="ichip">
      <ArrowIcon dir={diff > 0 ? 'up' : 'down'} />{Math.abs(diff)} {b.d.unit} {diff > 0 ? 'higher' : 'lower'} {since}
    </span>
  );
}

export function MarkerDrawer() {
  const key = useHealth(s => s.selectedMarkerId), selectMarker = useHealth(s => s.selectMarker);
  const measurements = useHealth(s => s.measurements), selectOrgan = useHealth(s => s.selectOrgan);
  const setView = useUI(s => s.setView);
  const system = useUnitSystem();
  const s = useMemo(() => buildSeries(measurements).find(x => x.key === key), [measurements, key]);
  const close = () => selectMarker(null);
  useEscape(close);
  // Move focus into the drawer while it is open and hand it back afterwards.
  const panel = useRef<HTMLElement>(null);
  const isOpen = !!key && !!s;
  useLayoutEffect(() => {
    if (!isOpen) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => { if (prev?.isConnected) prev.focus(); };
  }, [isOpen]);
  if (!key || !s) return null;
  const m = s.latest;
  const d = displayMeasurement(m, system);
  return (
    <div className="scrim" onClick={close}>
      <aside className="drawer md" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="mk-title" onClick={e => e.stopPropagation()}>
        <div className="dialog__head">
          <div>
            <p className="md-eyebrow"><SystemIcon system={s.def?.system ?? 'other'} size={16} />{s.def ? SYSTEM_LABELS[s.def.system] : 'Unmatched marker'}</p>
            <h2 id="mk-title">{s.name}</h2>
          </div>
          <button className="btn btn--quiet x" onClick={close} aria-label="Close">{Icon.close}</button>
        </div>
        <div className={`md-hero md-hero--${m.status}`}>
          <div className="md-hero__top">
            <span className="mval mval--xl"><b>{d.text}</b>{d.unit && <small>{d.unit}</small>}</span>
            <StatusChip status={m.status} />
          </div>
          <RangeBar m={m} labels />
          <div className="ichips">
            <span className="ichip"><UiIcon name="calendar" size={15} />{formatDate(m.date)}</span>
            <span className="ichip">{d.range ? `Range ${rangeText(d.range)}${d.unit ? ` ${d.unit}` : ''}` : 'No range given'}{m.range?.source === 'typical' ? ', typical adult range' : ''}</span>
            <Delta points={s.points} />
          </div>
        </div>
        <div className="section"><h3>Over time <small>{s.points.length} result{s.points.length > 1 ? 's' : ''}</small></h3>
          <div className="viz-card"><TrendChart points={s.points} title={s.name} height={240} /></div>
        </div>
        {s.def && <div className="section"><h3>What it measures</h3><p className="lede">{s.def.about}</p></div>}
        {s.def && (
          <div className="section"><h3>Related anatomy</h3>
            <div className="tools">{s.def.organs.map(o => <button key={o} className="btn" onClick={() => { selectOrgan(o); setView('body'); close(); }}>{Icon.body} {ORGAN_BY_ID[o]?.name ?? o}</button>)}</div>
          </div>
        )}
        <div className="section"><h3>All values</h3>
          <ul className="md-values">
            {[...s.points].reverse().map(p => {
              const pd = displayMeasurement(p, system);
              return (
                <li key={p.id}>
                  <span className="md-values__when"><b>{formatDate(p.date)}</b><small>from {p.sourceFile}</small></span>
                  <span className="md-values__val">{pd.text}<small> {pd.unit}</small></span>
                  <StatusChip status={p.status} size="sm" />
                </li>
              );
            })}
          </ul>
        </div>
        <p className="note">A single result outside its range is common and is not a diagnosis. Labs use different methods, so compare values from the same lab where you can.</p>
      </aside>
    </div>
  );
}

/* ---------- upload + review ---------- */
export function UploadDialog() {
  const open = useUI(s => s.uploadOpen), setOpen = useUI(s => s.setUploadOpen);
  const addResult = useHealth(s => s.addResult);
  const profile = useActiveProfile();
  const unitSystem = useUnitSystem();
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<ParseResult | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = () => { if (saving) return; setOpen(false); setDraft(null); setBusy(null); setFiles([]); setSaveError(null); };
  useEscape(close);
  if (!open) return null;
  const who = profile?.relationship === 'self' ? 'your' : `${firstName(profile)}’s`;

  async function save(d: ParseResult) {
    setSaving(true);
    setSaveError(null);
    try {
      const done = await addResult(d, files);
      setSaving(false);
      close();
      const parts = [done.measurements && `${done.measurements} result${done.measurements > 1 ? 's' : ''}`, done.scans && `${done.scans} scan${done.scans > 1 ? 's' : ''}`].filter(Boolean);
      toast.info(parts.length ? `Added ${parts.join(' and ')} to ${who} records.` : 'Everything in these files was already in the records.');
    } catch (e) {
      setSaving(false);
      setSaveError(`Nothing was added. ${errorMessage(e)}`);
    }
  }

  async function handle(list: FileList | File[]) {
    const merged: ParseResult = { measurements: [], scans: [], blobs: {}, warnings: [], detectedDate: null };
    const chosen = Array.from(list);
    setFiles(chosen);
    for (const f of chosen) {
      setBusy(`Reading ${f.name}…`);
      try {
        const r = await parseFile(f);
        merged.measurements.push(...r.measurements); merged.scans.push(...r.scans); Object.assign(merged.blobs, r.blobs);
        merged.warnings.push(...r.warnings.map(w => `${f.name}: ${w}`)); merged.detectedDate ??= r.detectedDate;
      } catch (e) { merged.warnings.push(`${f.name}: could not be read (${e instanceof Error ? e.message : String(e)}).`); }
    }
    setBusy(null); setDraft(merged);
  }
  const patch = (id: string, p: Partial<Measurement>) => setDraft(d => d && { ...d, measurements: d.measurements.map(m => m.id === id ? { ...m, ...p } : m) });
  const drop = (id: string) => setDraft(d => d && { ...d, measurements: d.measurements.filter(m => m.id !== id) });

  return (
    <div className="scrim" onClick={close}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="up-title" onClick={e => e.stopPropagation()}>
        <div className="dialog__head"><div><h2 id="up-title">{draft ? 'Check what was read' : 'Add results and scans'}</h2>
          <p className="muted">{draft
            ? `Edit anything that looks wrong, then add it to ${who} records.`
            : isPreview ? `Files are read on this device and saved to ${who} records in this browser.` : `Files are read on this device, then saved with the originals to ${who} records.`}</p></div>
          <button className="btn btn--quiet x" onClick={close} aria-label="Close">{Icon.close}</button></div>
        {!draft ? (
          <div className={`drop${over ? ' is-over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={e => { e.preventDefault(); setOver(false); void handle(e.dataTransfer.files); }}>
            <h3>{busy ?? 'Drop files here'}</h3>
            <p className="muted">or</p>
            <button className="btn btn--primary" style={{ marginTop: 10 }} onClick={() => input.current?.click()} disabled={!!busy}>{Icon.upload} Choose files</button>
            <input ref={input} type="file" multiple hidden accept=".pdf,.csv,.tsv,.txt,.json,.dcm,image/*,application/dicom" onChange={e => e.target.files && void handle(e.target.files)} />
            <div className="formats"><span>Lab report PDF</span><span>CSV or JSON export</span><span>DICOM (.dcm)</span><span>X-ray or scan photos</span></div>
          </div>
        ) : (
          <>
            {draft.warnings.map(w => <p key={w} className="warn">{w}</p>)}
            {draft.measurements.length > 0 && (
              <div className="table-wrap review-wrap"><table className="table review">
                <thead><tr><th>Marker</th><th>Value</th><th>Unit</th><th>Range</th><th>Date</th><th>Read as</th><th /></tr></thead>
                <tbody>
                  {draft.measurements.map(m => (
                    <tr key={m.id}>
                      <td><select value={m.markerId ?? ''} onChange={e => patch(m.id, { markerId: e.target.value || null })} aria-label="Marker">
                        <option value="">{m.rawName} (unmatched)</option>
                        {BIOMARKERS.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select></td>
                      <td><input value={m.valueText} aria-label="Value" onChange={e => { const v = parseFloat(e.target.value.replace(/,/g, '')); patch(m.id, { valueText: e.target.value, value: Number.isFinite(v) ? v : null }); }} />
                        {(() => { const d = displayMeasurement(m, unitSystem); return d.converted && <small className="review__alt" title="How this value is shown in your unit setting">Shown as {d.text} {d.unit}</small>; })()}</td>
                      <td><input value={m.unit} aria-label="Unit" onChange={e => patch(m.id, { unit: e.target.value })} /></td>
                      <td className="muted">{m.range?.text ?? 'None'}
                        {(() => { const d = displayMeasurement(m, unitSystem); return d.converted && d.range && <small className="review__alt">Shown as {rangeText(d.range)} {d.unit}</small>; })()}</td>
                      <td><input type="date" value={m.date ?? ''} aria-label="Date" onChange={e => patch(m.id, { date: e.target.value || null })} /></td>
                      <td><span className={`conf${m.confidence === 'low' ? ' conf--low' : ''}`}>{m.confidence === 'high' ? 'Clear' : m.confidence === 'medium' ? 'Check unit' : 'Check'}</span></td>
                      <td><button className="btn btn--quiet" onClick={() => drop(m.id)} aria-label={`Remove ${m.rawName}`}>{Icon.close}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
            {draft.scans.length > 0 && (
              <div className="section" style={{ marginTop: 12 }}><h3>Scans</h3>
                <div className="gallery">{draft.scans.map(s => (
                  <div className="scan-card" key={s.id}><div className="thumb"><img src={s.thumbDataUrl} alt="" /><ModalityBadge modality={s.modality} /></div>
                    <div className="scan-card__body"><b title={s.fileName}>{s.fileName}</b>
                      <OrganSelect value={s.organ} onChange={o => setDraft(d => d && { ...d, scans: d.scans.map(x => x.id === s.id ? { ...x, organ: o } : x) })} /></div></div>
                ))}</div>
              </div>
            )}
            {draft.measurements.length === 0 && draft.scans.length === 0 && <p className="lede" style={{ marginTop: 12 }}>Nothing could be read from these files. Try a text-based PDF, a CSV export, or image files.</p>}
            {saveError && <p className="form-error" role="alert" style={{ marginTop: 14 }}>{saveError}</p>}
            <div className="tools" style={{ marginTop: 20, justifyContent: 'flex-end' }}>
              <button className="btn" disabled={saving} onClick={() => { setDraft(null); setFiles([]); setSaveError(null); }}>Choose other files</button>
              <button className="btn btn--primary" disabled={saving || (!draft.measurements.length && !draft.scans.length)}
                onClick={() => void save(draft)}>{saving ? 'Saving…' : <>Add {draft.measurements.length ? `${draft.measurements.length} results` : ''}{draft.measurements.length && draft.scans.length ? ' and ' : ''}{draft.scans.length ? `${draft.scans.length} scans` : ''}</>}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- scan viewer ---------- */
export function ScanViewer() {
  const id = useUI(s => s.scanOpen), setScanOpen = useUI(s => s.setScanOpen);
  const scan = useHealth(s => s.scans.find(x => x.id === id));
  const updateScan = useHealth(s => s.updateScan), removeScan = useHealth(s => s.removeScan);
  const [url, setUrl] = useState<string | null>(null);
  const [dicom, setDicom] = useState<ArrayBuffer | null>(null);
  const [wl, setWl] = useState<{ center: number; width: number } | null>(null);
  const [zoom, setZoom] = useState(1); const [pan, setPan] = useState({ x: 0, y: 0 });
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const close = () => setScanOpen(null);
  useEscape(close);
  useEffect(() => {
    let alive = true, obj: string | null = null; setUrl(null); setDicom(null); setWl(null); setZoom(1); setPan({ x: 0, y: 0 });
    if (!scan) return;
    void getScanBlob(scan.blobKey).then(async b => {
      if (!alive || !b) return;
      if (scan.kind === 'dicom') setDicom(await b.arrayBuffer()); else { obj = URL.createObjectURL(b); setUrl(obj); }
    });
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
  }, [scan]);
  useEffect(() => {
    if (!dicom || !canvas.current) return;
    const r = renderDicom(dicom, wl ?? undefined); if (!r) return;
    canvas.current.width = r.width; canvas.current.height = r.height;
    canvas.current.getContext('2d')!.putImageData(r.imageData, 0, 0);
    if (!wl) setWl({ center: r.center, width: r.width_ });
  }, [dicom, wl]);
  if (!scan) return null;
  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'contain', transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom})` };
  return (
    <div className="scrim" onClick={close}>
      <div className="viewer" role="dialog" aria-modal="true" aria-labelledby="sv-title" onClick={e => e.stopPropagation()}>
        <header><h2 id="sv-title">{scan.fileName}</h2><span className="muted">{[scan.modality, scan.bodyPart, formatDate(scan.date)].filter(Boolean).join(', ')}</span>
          <button className="btn btn--quiet x" style={{ color: '#dcefec' }} onClick={close} aria-label="Close">{Icon.close}</button></header>
        <div className="viewer__img" onWheel={e => setZoom(z => Math.min(8, Math.max(1, z * Math.exp(-e.deltaY * 0.0015))))}
          onPointerDown={e => { drag.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); }}
          onPointerMove={e => drag.current && setPan({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y })} onPointerUp={() => { drag.current = null; }}>
          {scan.kind === 'dicom' ? <canvas ref={canvas} style={style} /> : url ? <img src={url} alt={scan.fileName} style={style} draggable={false} /> : null}
        </div>
        <footer>
          <label>Body area <OrganSelect value={scan.organ} onChange={o => updateScan(scan.id, { organ: o })} dark /></label>
          <label>Zoom <input type="range" min={1} max={8} step={0.1} value={zoom} onChange={e => setZoom(+e.target.value)} /></label>
          {scan.kind === 'dicom' && wl && (<>
            <label>Brightness <input type="range" min={wl.center - 2 * wl.width} max={wl.center + 2 * wl.width} value={wl.center} onChange={e => setWl({ ...wl, center: +e.target.value })} /></label>
            <label>Contrast <input type="range" min={1} max={Math.max(4000, wl.width * 4)} value={wl.width} onChange={e => setWl({ ...wl, width: +e.target.value })} /></label>
          </>)}
          <button className="btn btn--quiet" style={{ marginLeft: 'auto', color: '#f1b4c3' }} onClick={() => { removeScan(scan.id); close(); }}>Remove scan</button>
        </footer>
      </div>
    </div>
  );
}
