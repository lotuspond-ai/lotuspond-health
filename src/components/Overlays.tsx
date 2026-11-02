import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useHealth, getScanBlob } from '../lib/store';
import { parseFile } from '../lib/parse';
import { renderDicom } from '../lib/parse/dicom';
import { BIOMARKERS, SYSTEM_LABELS } from '../lib/catalog';
import { ORGAN_BY_ID } from '../anatomy/organs';
import { buildSeries, formatDate, STATUS_WORD } from '../lib/derive';
import { useUI } from '../state/ui';
import { Icon, RangeBar, TrendChart } from './ui';
import { OrganSelect } from '../pages/Scans';
import type { Measurement, ParseResult } from '../types';

function useEscape(close: () => void) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && close(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [close]);
}

/* ---------- marker detail ---------- */
export function MarkerDrawer() {
  const key = useHealth(s => s.selectedMarkerId), selectMarker = useHealth(s => s.selectMarker);
  const measurements = useHealth(s => s.measurements), selectOrgan = useHealth(s => s.selectOrgan);
  const setView = useUI(s => s.setView);
  const s = useMemo(() => buildSeries(measurements).find(x => x.key === key), [measurements, key]);
  const close = () => selectMarker(null);
  useEscape(close);
  if (!key || !s) return null;
  const m = s.latest;
  return (
    <div className="scrim" onClick={close}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="mk-title" onClick={e => e.stopPropagation()}>
        <div className="dialog__head"><div><p className="muted">{s.def ? SYSTEM_LABELS[s.def.system] : 'Unmatched marker'}</p><h2 id="mk-title">{s.name}</h2></div>
          <button className="btn btn--quiet x" onClick={close} aria-label="Close">{Icon.close}</button></div>
        <div className="section tally" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div><b>{m.valueText}</b><span>{m.unit}, {formatDate(m.date)}</span></div>
          <div><b className={`st-${m.status}`} style={{ fontSize: 24, paddingTop: 8 }}>{STATUS_WORD[m.status]}</b><span>{m.range?.text ? `Range ${m.range.text}` : 'No range given'}{m.range?.source === 'typical' ? ' (typical adult range)' : ''}</span></div>
        </div>
        <div className="section"><RangeBar m={m} /></div>
        <div className="section"><h3>Over time</h3><TrendChart points={s.points} /></div>
        {s.def && <div className="section"><h3>What it measures</h3><p className="lede">{s.def.about}</p></div>}
        {s.def && (
          <div className="section"><h3>Related anatomy</h3>
            <div className="tools">{s.def.organs.map(o => <button key={o} className="btn" onClick={() => { selectOrgan(o); setView('body'); close(); }}>{Icon.body} {ORGAN_BY_ID[o]?.name ?? o}</button>)}</div>
          </div>
        )}
        <div className="section"><h3>All values</h3>
          {[...s.points].reverse().map(p => <p key={p.id} style={{ display: 'flex', justifyContent: 'space-between', margin: '6px 0' }}><span>{formatDate(p.date)} <span className="muted">from {p.sourceFile}</span></span><b style={{ fontWeight: 600 }} className={`st-${p.status}`}>{p.valueText} {p.unit}</b></p>)}
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
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<ParseResult | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = () => { setOpen(false); setDraft(null); setBusy(null); };
  useEscape(close);
  if (!open) return null;

  async function handle(files: FileList | File[]) {
    const merged: ParseResult = { measurements: [], scans: [], blobs: {}, warnings: [], detectedDate: null };
    for (const f of Array.from(files)) {
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
          <p className="muted">{draft ? 'Edit anything that looks wrong, then add it to your body map.' : 'Files are read on this device. Nothing is uploaded to a server.'}</p></div>
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
              <table className="table review" style={{ marginTop: 12 }}>
                <thead><tr><th>Marker</th><th>Value</th><th>Unit</th><th>Range</th><th>Date</th><th>Read as</th><th /></tr></thead>
                <tbody>
                  {draft.measurements.map(m => (
                    <tr key={m.id}>
                      <td><select value={m.markerId ?? ''} onChange={e => patch(m.id, { markerId: e.target.value || null })} aria-label="Marker">
                        <option value="">{m.rawName} (unmatched)</option>
                        {BIOMARKERS.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select></td>
                      <td><input value={m.valueText} aria-label="Value" onChange={e => { const v = parseFloat(e.target.value.replace(/,/g, '')); patch(m.id, { valueText: e.target.value, value: Number.isFinite(v) ? v : null }); }} /></td>
                      <td><input value={m.unit} aria-label="Unit" onChange={e => patch(m.id, { unit: e.target.value })} /></td>
                      <td className="muted">{m.range?.text ?? '—'}</td>
                      <td><input type="date" value={m.date ?? ''} aria-label="Date" onChange={e => patch(m.id, { date: e.target.value || null })} /></td>
                      <td><span className={`conf${m.confidence === 'low' ? ' conf--low' : ''}`}>{m.confidence === 'high' ? 'Clear' : m.confidence === 'medium' ? 'Check unit' : 'Check'}</span></td>
                      <td><button className="btn btn--quiet" onClick={() => drop(m.id)} aria-label={`Remove ${m.rawName}`}>{Icon.close}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {draft.scans.length > 0 && (
              <div className="section" style={{ marginTop: 12 }}><h3>Scans</h3>
                <div className="gallery">{draft.scans.map(s => (
                  <div className="scan-card" key={s.id}><div className="thumb"><img src={s.thumbDataUrl} alt="" /><span>{s.modality ?? 'Scan'}</span></div><b>{s.fileName}</b>
                    <OrganSelect value={s.organ} onChange={o => setDraft(d => d && { ...d, scans: d.scans.map(x => x.id === s.id ? { ...x, organ: o } : x) })} /></div>
                ))}</div>
              </div>
            )}
            {draft.measurements.length === 0 && draft.scans.length === 0 && <p className="lede" style={{ marginTop: 12 }}>Nothing could be read from these files. Try a text-based PDF, a CSV export, or image files.</p>}
            <div className="tools" style={{ marginTop: 20, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setDraft(null)}>Choose other files</button>
              <button className="btn btn--primary" disabled={!draft.measurements.length && !draft.scans.length}
                onClick={() => { addResult(draft); close(); }}>Add {draft.measurements.length ? `${draft.measurements.length} results` : ''}{draft.measurements.length && draft.scans.length ? ' and ' : ''}{draft.scans.length ? `${draft.scans.length} scans` : ''}</button>
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
