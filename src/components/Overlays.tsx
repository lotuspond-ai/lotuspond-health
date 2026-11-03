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
import { isNative } from '../native/platform';
import type { Measurement, ParseResult } from '../types';

/** File picker filter on the web. The apps accept any file: phone pickers grey out types they cannot map
 *  (DICOM is usually application/octet-stream there), and every file is checked by content anyway. */
const ACCEPT = isNative ? undefined : '.pdf,.csv,.tsv,.txt,.json,.dcm,image/*,application/dicom';

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

/**
 * iOS names every camera shot (and photos picked from the library) "image.jpg". Give those distinct names,
 * otherwise a second photo of the same size looks like a duplicate of the first and is skipped.
 */
function distinctPhotoNames(files: File[]): File[] {
  const now = new Date();
  // "09h05m01s": dotted times such as 09.05.01 would be read back as a date by the scan date parser.
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n, i) => String(n).padStart(2, '0') + 'hms'[i]).join('');
  return files.map((f, i) => {
    const m = /^image\.(jpe?g|png|heic|heif|webp)$/i.exec(f.name);
    return m ? new File([f], `Photo ${time}${files.length > 1 ? ` (${i + 1})` : ''}.${m[1].toLowerCase()}`, { type: f.type, lastModified: f.lastModified }) : f;
  });
}

const takeFiles = (input: HTMLInputElement): File[] => {
  const files = distinctPhotoNames(Array.from(input.files ?? []));
  input.value = ''; // so choosing the same file again still fires a change
  return files;
};

/* ---------- upload + review ---------- */
export function UploadDialog() {
  const open = useUI(s => s.uploadOpen);
  // Mounted only while open, so closing from anywhere (Escape, Android back) starts the next upload fresh.
  return open ? <UploadPanel /> : null;
}

function UploadPanel() {
  const setOpen = useUI(s => s.setUploadOpen);
  const addResult = useHealth(s => s.addResult);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<ParseResult | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const close = () => setOpen(false);
  useEscape(close);

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
      <div className="dialog dialog--upload" role="dialog" aria-modal="true" aria-labelledby="up-title" onClick={e => e.stopPropagation()}>
        <div className="dialog__head"><div><h2 id="up-title">{draft ? 'Check what was read' : 'Add results and scans'}</h2>
          <p className="muted">{draft ? 'Edit anything that looks wrong, then add it to your body map.' : 'Files are read on this device. Nothing is uploaded to a server.'}</p></div>
          <button className="btn btn--quiet x" onClick={close} aria-label="Close">{Icon.close}</button></div>
        {!draft ? (
          <div className={`drop${over ? ' is-over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={e => { e.preventDefault(); setOver(false); void handle(e.dataTransfer.files); }}>
            <h3>{busy ?? <><span className="only-fine">Drop files here</span><span className="only-touch">Add a report, scan or backup</span></>}</h3>
            <p className="muted only-fine">or</p>
            <div className="drop__actions">
              <button className="btn btn--primary" onClick={() => input.current?.click()} disabled={!!busy}>{Icon.upload} Choose files</button>
              <button className="btn only-touch" onClick={() => camera.current?.click()} disabled={!!busy}>{Icon.camera} Take a photo</button>
            </div>
            <input ref={input} type="file" multiple hidden accept={ACCEPT} onChange={e => { const f = takeFiles(e.target); if (f.length) void handle(f); }} />
            <input ref={camera} type="file" hidden accept="image/*" capture="environment" onChange={e => { const f = takeFiles(e.target); if (f.length) void handle(f); }} />
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
            <div className="tools dialog__actions">
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
  // Active pointers and the gesture they started: one finger / mouse pans, two fingers pinch-zoom.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ pan: { x: number; y: number }; zoom: number; mid: { x: number; y: number }; dist: number; moved: boolean } | null>(null);
  const lastTap = useRef(0);
  const lastPointer = useRef('mouse');
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
  const startGesture = () => {
    const pts = [...pointers.current.values()];
    const mid = pts.length > 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0];
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture.current = pts.length ? { pan, zoom, mid, dist, moved: gesture.current?.moved ?? false } : null;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    lastPointer.current = e.pointerType;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) gesture.current = null;
    startGesture();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current, pts = [...pointers.current.values()];
    const mid = pts.length > 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0];
    if (Math.hypot(mid.x - g.mid.x, mid.y - g.mid.y) > 4) g.moved = true;
    if (pts.length > 1 && g.dist > 0) {
      g.moved = true;
      setZoom(Math.min(8, Math.max(1, g.zoom * Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) / g.dist)));
    }
    setPan({ x: g.pan.x + mid.x - g.mid.x, y: g.pan.y + mid.y - g.mid.y });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const tapped = gesture.current && !gesture.current.moved && pointers.current.size === 0;
    if (pointers.current.size) startGesture(); else gesture.current = null;
    if (zoom <= 1.02 && pointers.current.size === 0) setPan({ x: 0, y: 0 });
    if (tapped && e.pointerType !== 'mouse') {
      // Double tap: zoom in to 2.5x, or back out to fit.
      if (e.timeStamp - lastTap.current < 320) { setZoom(zoom > 1.05 ? 1 : 2.5); if (zoom > 1.05) setPan({ x: 0, y: 0 }); lastTap.current = 0; }
      else lastTap.current = e.timeStamp;
    }
  };
  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'contain', transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom})` };
  return (
    <div className="scrim" onClick={close}>
      <div className="viewer" role="dialog" aria-modal="true" aria-labelledby="sv-title" onClick={e => e.stopPropagation()}>
        <header><h2 id="sv-title">{scan.fileName}</h2><span className="muted">{[scan.modality, scan.bodyPart, formatDate(scan.date)].filter(Boolean).join(', ')}</span>
          <button className="btn btn--quiet x" style={{ color: '#dcefec' }} onClick={close} aria-label="Close">{Icon.close}</button></header>
        <div className="viewer__img" onWheel={e => setZoom(z => Math.min(8, Math.max(1, z * Math.exp(-e.deltaY * 0.0015))))}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onDoubleClick={() => { if (lastPointer.current !== 'mouse') return; setZoom(zoom > 1.05 ? 1 : 2.5); if (zoom > 1.05) setPan({ x: 0, y: 0 }); }}>
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
