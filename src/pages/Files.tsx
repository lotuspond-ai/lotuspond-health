import { useMemo, useState } from 'react';
import type { ScanItem, StoredDocument } from '../types';
import { backend, errorMessage, inApp, isPreview } from '../api';
import { shareBlob } from '../native/share';
import { toast } from '../state/toast';
import { useHealth } from '../lib/store';
import { possessive, useActiveProfile } from '../state/session';
import { useUI } from '../state/ui';
import { ORGAN_BY_ID } from '../anatomy/organs';
import { ConfirmButton } from '../components/forms';
import { Icon } from '../components/ui';
import { FileTypeIcon, FileTypeLabel, ModalityBadge, UiIcon } from '../components/icons';
import { formatBytes } from '../lib/profile';

const KIND_LABEL: Record<StoredDocument['kind'], string> = { report: 'Lab report', scan: 'Scan', other: 'Other' };
const INLINE = /^(image\/(png|jpeg|webp|gif|avif)|application\/pdf)$/;
const LAYOUT_KEY = 'lotuspond:files-layout';

function uploadedOn(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(+d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function savedLayout(): 'cards' | 'table' {
  try { return localStorage.getItem(LAYOUT_KEY) === 'table' ? 'table' : 'cards'; } catch { return 'cards'; }
}

interface FileInfo { d: StoredDocument; scan?: ScanItem; results: number; open: string | null; download: string | null }

function linkedText(f: FileInfo): string {
  if (f.scan) return `Scan${f.scan.organ ? `, ${ORGAN_BY_ID[f.scan.organ]?.name ?? f.scan.organ}` : ''}`;
  return f.results ? `${f.results} result${f.results > 1 ? 's' : ''}` : 'Not linked';
}

/** In the apps files cannot be linked to (requests need the sign-in token): fetch the original and share it. */
function ShareFile({ d }: { d: StoredDocument }) {
  const profileId = useHealth(s => s.profileId);
  const [busy, setBusy] = useState(false);
  if (!inApp || !profileId) return null;
  const share = async () => {
    setBusy(true);
    try { await shareBlob(await backend.documentFile(profileId, d.id), d.fileName, d.fileName); }
    catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return <button className="btn btn--quiet" disabled={busy} onClick={() => void share()} aria-label={`Open or save ${d.fileName}`}>{Icon.share} {busy ? 'Opening…' : 'Open or save'}</button>;
}

function Actions({ f, compact }: { f: FileInfo; compact?: boolean }) {
  const setScanOpen = useUI(s => s.setScanOpen);
  const removeDocument = useHealth(s => s.removeDocument);
  const { d, scan, open, download } = f;
  return (
    <div className={compact ? 'row-actions' : 'fcard__actions'}>
      {scan && <button className="btn btn--quiet" onClick={() => setScanOpen(scan.id)} aria-label={`View ${d.fileName}`}>{Icon.eye} View</button>}
      {!scan && open && INLINE.test(d.contentType) && <a className="btn btn--quiet" href={open} target="_blank" rel="noopener" aria-label={`Open ${d.fileName}`}>{Icon.eye} Open</a>}
      {download && <a className="btn btn--quiet" href={download} download={d.fileName} aria-label={`Download ${d.fileName}`}>{Icon.download} Download</a>}
      {!download && <ShareFile d={d} />}
      <ConfirmButton className="btn btn--quiet btn--danger-text" confirmText={scan ? 'Delete the file and its scan?' : 'Delete this file?'}
        onConfirm={() => removeDocument(d.id)}>Delete</ConfirmButton>
    </div>
  );
}

function FileCard({ f }: { f: FileInfo }) {
  const { d, scan } = f;
  return (
    <li className="fcard" data-file={d.id}>
      <div className={`fcard__preview${scan ? ' fcard__preview--scan' : ''}`}>
        {scan ? <><img src={scan.thumbDataUrl} alt="" /><ModalityBadge modality={scan.modality} /></>
          : <span className="fcard__doc"><FileTypeIcon fileName={d.fileName} contentType={d.contentType} size={34} /><em><FileTypeLabel fileName={d.fileName} contentType={d.contentType} /></em></span>}
      </div>
      <div className="fcard__body">
        <b className="fcard__name" title={d.fileName}>{d.fileName}</b>
        <span className="ichips">
          <span className={`ichip ichip--sm ichip--${d.kind}`}>{d.kind === 'scan' ? <UiIcon name="scan" size={14} /> : <UiIcon name="flask" size={14} />}{KIND_LABEL[d.kind]}</span>
          <span className="ichip ichip--sm"><FileTypeLabel fileName={d.fileName} contentType={d.contentType} /></span>
        </span>
        <dl className="fcard__meta">
          <div><dt>Linked to</dt><dd>{linkedText(f)}</dd></div>
          <div><dt>Size</dt><dd>{formatBytes(d.sizeBytes)}</dd></div>
          <div><dt>Uploaded</dt><dd>{uploadedOn(d.createdAt)}</dd></div>
        </dl>
        <Actions f={f} />
      </div>
    </li>
  );
}

export default function Files() {
  const profile = useActiveProfile();
  const { documents, measurements, scans, profileId } = useHealth();
  const setUploadOpen = useUI(s => s.setUploadOpen);
  const [layout, setLayoutState] = useState(savedLayout);
  const setLayout = (l: 'cards' | 'table') => { setLayoutState(l); try { localStorage.setItem(LAYOUT_KEY, l); } catch { /* storage unavailable */ } };
  const files = useMemo<FileInfo[]>(() => {
    const results = new Map<string, number>();
    for (const m of measurements) if (m.documentId) results.set(m.documentId, (results.get(m.documentId) ?? 0) + 1);
    const scanByDoc = new Map(scans.map(s => [s.blobKey, s]));
    return documents.map(d => ({
      d, scan: scanByDoc.get(d.id), results: results.get(d.id) ?? 0,
      open: profileId ? backend.documentUrl(profileId, d.id) : null,
      download: profileId ? backend.documentUrl(profileId, d.id, true) : null,
    }));
  }, [documents, measurements, scans, profileId]);
  const total = documents.reduce((n, d) => n + d.sizeBytes, 0);
  const reports = documents.filter(d => d.kind === 'report').length, scanFiles = documents.filter(d => d.kind === 'scan').length;

  return (
    <main className="page">
      <div className="page__head">
        <div>
          <h1>Files</h1>
          <p>The original reports and scans in {profile?.relationship === 'self' ? 'your' : possessive(profile)} records. Deleting a report keeps the results read from it; deleting a scan file removes the scan.</p>
        </div>
        <span className="spacer" />
        {documents.length > 0 && (
          <div className="seg" role="group" aria-label="Layout">
            <button aria-pressed={layout === 'cards'} onClick={() => setLayout('cards')}><UiIcon name="grid" size={15} />Cards</button>
            <button aria-pressed={layout === 'table'} onClick={() => setLayout('table')}><UiIcon name="list" size={15} />Table</button>
          </div>
        )}
        <button className="btn btn--primary" onClick={() => setUploadOpen(true)}>{Icon.upload} Upload files</button>
      </div>
      {documents.length === 0 ? (
        <div className="callout empty">
          <span className="empty__icon">{Icon.file}</span>
          <p className="lede">No files yet. When you upload a lab report or scan, the original is kept here alongside the values read from it.</p>
        </div>
      ) : (
        <>
          <div className="ichips page-stats">
            {reports > 0 && <span className="ichip"><UiIcon name="flask" size={15} />{reports} lab report{reports > 1 ? 's' : ''}</span>}
            {scanFiles > 0 && <span className="ichip"><UiIcon name="scan" size={15} />{scanFiles} scan{scanFiles > 1 ? 's' : ''}</span>}
            <span className="ichip">{formatBytes(total)} in total</span>
          </div>
          {layout === 'cards' ? (
            <ul className="fgrid">{files.map(f => <FileCard key={f.d.id} f={f} />)}</ul>
          ) : (
            <div className="table-wrap">
              <table className="table files">
                <thead><tr><th>File</th><th>Type</th><th>Linked to</th><th>Size</th><th>Uploaded</th><th aria-label="Actions" /></tr></thead>
                <tbody>
                  {files.map(f => (
                    <tr key={f.d.id} data-file={f.d.id}>
                      <td><span className="file-name"><FileTypeIcon fileName={f.d.fileName} contentType={f.d.contentType} size={20} /><b title={f.d.fileName}>{f.d.fileName}</b></span></td>
                      <td className="muted">{KIND_LABEL[f.d.kind]}</td>
                      <td className="muted">{linkedText(f)}</td>
                      <td className="muted">{formatBytes(f.d.sizeBytes)}</td>
                      <td className="muted">{uploadedOn(f.d.createdAt)}</td>
                      <td><Actions f={f} compact /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="note" style={{ marginTop: 14 }}>
            {documents.length} file{documents.length > 1 ? 's' : ''}, {formatBytes(total)} in total.
            {isPreview && ' In this preview, files are kept in this browser and cannot be downloaded again; the full app stores them on the server.'}
          </p>
        </>
      )}
    </main>
  );
}
