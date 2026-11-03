import { useMemo } from 'react';
import type { StoredDocument } from '../types';
import { backend, isPreview } from '../api';
import { useHealth } from '../lib/store';
import { possessive, useActiveProfile } from '../state/session';
import { useUI } from '../state/ui';
import { ORGAN_BY_ID } from '../anatomy/organs';
import { ConfirmButton } from '../components/forms';
import { Icon } from '../components/ui';
import { formatBytes } from '../lib/profile';

const KIND_LABEL: Record<StoredDocument['kind'], string> = { report: 'Lab report', scan: 'Scan', other: 'Other' };
const INLINE = /^(image\/(png|jpeg|webp|gif|avif)|application\/pdf)$/;

function uploadedOn(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(+d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function Files() {
  const profile = useActiveProfile();
  const { documents, measurements, scans, removeDocument, profileId } = useHealth();
  const { setUploadOpen, setScanOpen } = useUI();
  const links = useMemo(() => {
    const results = new Map<string, number>();
    for (const m of measurements) if (m.documentId) results.set(m.documentId, (results.get(m.documentId) ?? 0) + 1);
    const scanByDoc = new Map(scans.map(s => [s.blobKey, s]));
    return { results, scanByDoc };
  }, [measurements, scans]);
  const total = documents.reduce((n, d) => n + d.sizeBytes, 0);

  return (
    <main className="page">
      <div className="page__head">
        <div>
          <h1>Files</h1>
          <p>The original reports and scans in {profile?.relationship === 'self' ? 'your' : possessive(profile)} records. Deleting a report keeps the results read from it; deleting a scan file removes the scan.</p>
        </div>
        <span className="spacer" />
        <button className="btn btn--primary" onClick={() => setUploadOpen(true)}>{Icon.upload} Upload files</button>
      </div>
      {documents.length === 0 ? (
        <div className="callout"><p className="lede">No files yet. When you upload a lab report or scan, the original is kept here alongside the values read from it.</p></div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table files">
              <thead><tr><th>File</th><th>Type</th><th>Linked to</th><th>Size</th><th>Uploaded</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {documents.map(d => {
                  const scan = links.scanByDoc.get(d.id);
                  const results = links.results.get(d.id) ?? 0;
                  const open = profileId ? backend.documentUrl(profileId, d.id) : null;
                  const download = profileId ? backend.documentUrl(profileId, d.id, true) : null;
                  return (
                    <tr key={d.id}>
                      <td><span className="file-name">{d.kind === 'scan' ? Icon.image : Icon.file}<b title={d.fileName}>{d.fileName}</b></span></td>
                      <td className="muted">{KIND_LABEL[d.kind]}</td>
                      <td className="muted">{scan ? `Scan${scan.organ ? `, ${ORGAN_BY_ID[scan.organ]?.name ?? scan.organ}` : ''}` : results ? `${results} result${results > 1 ? 's' : ''}` : '—'}</td>
                      <td className="muted">{formatBytes(d.sizeBytes)}</td>
                      <td className="muted">{uploadedOn(d.createdAt)}</td>
                      <td>
                        <div className="row-actions">
                          {scan && <button className="btn btn--quiet" onClick={() => setScanOpen(scan.id)}>{Icon.eye} View</button>}
                          {!scan && open && INLINE.test(d.contentType) && <a className="btn btn--quiet" href={open} target="_blank" rel="noopener">{Icon.eye} Open</a>}
                          {download && <a className="btn btn--quiet" href={download} download={d.fileName}>{Icon.download} Download</a>}
                          <ConfirmButton className="btn btn--quiet btn--danger-text" confirmText={scan ? 'Delete the file and its scan?' : 'Delete this file?'}
                            onConfirm={() => removeDocument(d.id)}>Delete</ConfirmButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="note" style={{ marginTop: 14 }}>
            {documents.length} file{documents.length > 1 ? 's' : ''}, {formatBytes(total)} in total.
            {isPreview && ' In this preview, files are kept in this browser and cannot be downloaded again; the full app stores them on the server.'}
          </p>
        </>
      )}
    </main>
  );
}
