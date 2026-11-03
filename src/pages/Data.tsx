import { useState } from 'react';
import { useHealth, dates } from '../lib/store';
import { useUI } from '../state/ui';
import { formatDate } from '../lib/derive';
import { saveExport } from '../native/save';
import { isNative } from '../native/platform';
import { Icon } from '../components/ui';

export default function DataPage() {
  const measurements = useHealth(s => s.measurements), scans = useHealth(s => s.scans);
  const clearAll = useHealth(s => s.clearAll), loadSample = useHealth(s => s.loadSample);
  const { setUploadOpen, setView } = useUI();
  const [status, setStatus] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const sampleDates = dates(measurements);
  const empty = measurements.length === 0 && scans.length === 0;

  async function exportNow() {
    setStatus(null);
    try {
      await saveExport({ measurements, scans });
      if (!isNative) setStatus('Backup downloaded.');
    } catch (e) {
      setStatus(`The backup could not be saved (${e instanceof Error ? e.message : String(e)}).`);
    }
  }

  return (
    <main className="page page--narrow">
      <div className="page__head">
        <div><h1>Your data</h1><p>Everything LotusPond reads stays on this {isNative ? 'phone' : 'device, in this browser'}. There is no account and no server, so a backup file is the only copy outside it.</p></div>
      </div>

      <div className="section tally">
        <div><b>{measurements.length}</b><span>results</span></div>
        <div><b>{scans.length}</b><span>scans</span></div>
        <div><b>{sampleDates.length}</b><span>{sampleDates.length ? `report dates, latest ${formatDate(sampleDates[sampleDates.length - 1], { month: 'short', year: 'numeric' })}` : 'report dates'}</span></div>
      </div>

      <div className="section">
        <h3>Back up</h3>
        <p className="lede">Save every result, plus each scan's details and preview, as one file. Original scan files are not included, so keep those too.{isNative ? ' Choose where it goes, for example Files or your own cloud drive.' : ''}</p>
        <div className="tools" style={{ marginTop: 12 }}>
          <button className="btn btn--primary" disabled={empty} onClick={() => void exportNow()}>{isNative ? Icon.share : Icon.upload} Export backup</button>
        </div>
        {status && <p className="note" role="status" style={{ marginTop: 8 }}>{status}</p>}
      </div>

      <div className="section">
        <h3>Restore or move from another device</h3>
        <p className="lede">Add a backup file the same way as a lab report. Results already here are kept and duplicates are skipped.</p>
        <div className="tools" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => setUploadOpen(true)}>{Icon.plus} Add a backup file</button>
          {empty && <button className="btn" onClick={() => { loadSample(); setView('body'); }}>Explore with sample data</button>}
        </div>
      </div>

      <div className="section">
        <h3>Delete everything</h3>
        <p className="lede">Remove all results and scans from this {isNative ? 'app' : 'browser'}. This cannot be undone.</p>
        <div className="tools" style={{ marginTop: 12 }}>
          {confirming ? (
            <>
              <button className="btn btn--danger" onClick={() => { clearAll(); setConfirming(false); setStatus(null); }}>{Icon.trash} Delete all data</button>
              <button className="btn" onClick={() => setConfirming(false)}>Keep my data</button>
            </>
          ) : (
            <button className="btn" disabled={empty} onClick={() => setConfirming(true)}>{Icon.trash} Delete all data…</button>
          )}
        </div>
      </div>

      <div className="section">
        <p className="note">LotusPond explains results; it does not diagnose. Discuss results with a clinician before acting on them.</p>
      </div>
    </main>
  );
}
