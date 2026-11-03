import { useHealth } from '../lib/store';
import { useUI } from '../state/ui';
import { ORGANS, ORGAN_BY_ID } from '../anatomy/organs';
import { formatDate } from '../lib/derive';
import { Icon } from '../components/ui';
import { ModalityBadge, ModalityIcon, UiIcon } from '../components/icons';
import { modalityLabel } from '../components/icons/kinds';
import type { OrganId, ScanItem } from '../types';

export function OrganSelect({ value, onChange, dark }: { value: OrganId | null; onChange: (o: OrganId | null) => void; dark?: boolean }) {
  return (
    <select value={value ?? ''} onChange={e => onChange((e.target.value || null) as OrganId | null)} aria-label="Body area" style={dark ? undefined : {}}>
      <option value="">Not assigned</option>
      {ORGANS.filter(o => o.id !== 'skin').map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
}

/** Scan counts by modality, most common first: [label, a modality code for the icon, count]. */
function byModality(scans: ScanItem[]): [string, string | undefined, number][] {
  const m = new Map<string, [string | undefined, number]>();
  for (const s of scans) { const k = modalityLabel(s.modality); const e = m.get(k); m.set(k, [s.modality, (e?.[1] ?? 0) + 1]); }
  return [...m.entries()].map(([k, [code, n]]) => [k, code, n] as [string, string | undefined, number]).sort((a, b) => b[2] - a[2]);
}

export default function Scans() {
  const scans = useHealth(s => s.scans);
  const updateScan = useHealth(s => s.updateScan);
  const selectOrgan = useHealth(s => s.selectOrgan);
  const { setUploadOpen, setScanOpen, setView } = useUI();
  const assigned = scans.filter(s => s.organ).length;
  return (
    <main className="page">
      <div className="page__head">
        <div><h1>Scans</h1><p>X-rays, ultrasound, CT, MRI and photos. Assign each to a body area so it appears on that organ.</p></div>
        <span className="spacer" />
        <button className="btn btn--primary" onClick={() => setUploadOpen(true)}>{Icon.upload} Add scans</button>
      </div>
      {scans.length === 0 ? (
        <div className="callout empty">
          <span className="empty__icon"><UiIcon name="scan" size={26} /></span>
          <p className="lede">No scans yet. DICOM files (.dcm) and images (JPG, PNG, WebP) are supported.</p>
          <button className="btn btn--primary" onClick={() => setUploadOpen(true)}>{Icon.upload} Add scans</button>
        </div>
      ) : (
        <>
          <div className="ichips page-stats">
            {byModality(scans).map(([label, code, n]) => <span key={label} className="ichip"><ModalityIcon modality={code} size={15} />{n} {label}</span>)}
            <span className="ichip">{Icon.body}{assigned} of {scans.length} placed on the body</span>
          </div>
          <ul className="gallery">
            {scans.map(s => (
              <li className="scan-card" key={s.id}>
                <button className="thumb" onClick={() => setScanOpen(s.id)} aria-label={`Open scan ${s.fileName}`}>
                  <img src={s.thumbDataUrl} alt="" /><ModalityBadge modality={s.modality} />
                </button>
                <div className="scan-card__body">
                  <b title={s.fileName}>{s.fileName}</b>
                  <span className="ichips">
                    <span className="ichip ichip--sm"><UiIcon name="calendar" size={14} />{formatDate(s.date)}</span>
                    {s.bodyPart && <span className="ichip ichip--sm">{s.bodyPart}</span>}
                  </span>
                  <div className="scan-card__row">
                    <OrganSelect value={s.organ} onChange={o => updateScan(s.id, { organ: o })} />
                    {s.organ && (
                      <button className="linkish" onClick={() => { selectOrgan(s.organ); setView('body'); }}
                        aria-label={`Show ${ORGAN_BY_ID[s.organ]?.name ?? 'organ'} on the body map`}>{Icon.body} Show on body</button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
