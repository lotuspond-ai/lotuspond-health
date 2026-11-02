import { useHealth } from '../lib/store';
import { useUI } from '../state/ui';
import { ORGANS } from '../anatomy/organs';
import { formatDate } from '../lib/derive';
import { Icon } from '../components/ui';
import type { OrganId } from '../types';

export function OrganSelect({ value, onChange, dark }: { value: OrganId | null; onChange: (o: OrganId | null) => void; dark?: boolean }) {
  return (
    <select value={value ?? ''} onChange={e => onChange((e.target.value || null) as OrganId | null)} aria-label="Body area" style={dark ? undefined : {}}>
      <option value="">Not assigned</option>
      {ORGANS.filter(o => o.id !== 'skin').map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
}

export default function Scans() {
  const scans = useHealth(s => s.scans);
  const updateScan = useHealth(s => s.updateScan);
  const selectOrgan = useHealth(s => s.selectOrgan);
  const { setUploadOpen, setScanOpen, setView } = useUI();
  return (
    <main className="page">
      <div className="page__head">
        <div><h1>Scans</h1><p>X-rays, ultrasound, CT, MRI and photos. Assign each to a body area so it appears on that organ.</p></div>
        <span className="spacer" />
        <button className="btn btn--primary" onClick={() => setUploadOpen(true)}>{Icon.upload} Add scans</button>
      </div>
      {scans.length === 0 ? (
        <div className="callout"><p className="lede">No scans yet. DICOM files (.dcm) and images (JPG, PNG, WebP) are supported. Images are kept in this browser only.</p></div>
      ) : (
        <div className="gallery">
          {scans.map(s => (
            <div className="scan-card" key={s.id}>
              <button className="thumb" onClick={() => setScanOpen(s.id)}><img src={s.thumbDataUrl} alt={`Scan ${s.fileName}`} /><span>{s.modality ?? 'Scan'}</span></button>
              <b title={s.fileName}>{s.fileName}</b>
              <span className="muted" style={{ fontSize: 13 }}>{[s.bodyPart, formatDate(s.date)].filter(Boolean).join(', ')}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <OrganSelect value={s.organ} onChange={o => updateScan(s.id, { organ: o })} />
                {s.organ && <button className="btn btn--quiet" onClick={() => { selectOrgan(s.organ); setView('body'); }}>Show on body</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
