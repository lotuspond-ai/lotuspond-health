// Upload review: when a photo or scanned PDF was hard to read on the device, offer to read it with Claude
// (docs/report-reading.md). Nothing is sent until the person ticks the notice for that file and presses the button;
// the server records that consent. Claude's rows replace the device read of that file in the review table, where
// the person checks them like any other upload before adding.
import { useState } from 'react';
import { backend, errorMessage, isPreview } from '../api';
import { parseJsonText } from '../lib/parse/json';
import { prepareImage } from '../lib/parse/ocr-read';
import { worthBetterRead } from '../lib/parse/ocr';
import { useActiveProfile, useSession } from '../state/session';
import { usePublicConfig } from './labs/store';
import { countryName } from '../../shared/regions';
import type { FileRead, ParseResult } from '../types';
import '../styles/agents.css';

/** Photos are sent at most this size (Claude takes images up to 5 MB). */
const MAX_SEND_BYTES = 4.5 * 1024 * 1024;

async function sendable(file: File): Promise<Blob> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return file;
  if (file.size <= MAX_SEND_BYTES && /^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  const canvas = await prepareImage(file);
  for (const q of [0.88, 0.75, 0.6]) {
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= MAX_SEND_BYTES) return blob;
  }
  throw new Error('This photo is too large to send. Try a smaller one.');
}

export function AiReadOffers({ draft, files, onRead }: {
  draft: ParseResult;
  files: File[];
  onRead: (fileName: string, result: ParseResult) => void;
}) {
  const cfg = usePublicConfig();
  if (isPreview || !cfg?.aiExtraction) return null;
  const offers = (draft.reads ?? []).filter(r => worthBetterRead(r, draft) && files.some(f => f.name === r.fileName));
  if (!offers.length) return null;
  return <>{offers.map(r => <Offer key={r.fileName} read={r} file={files.find(f => f.name === r.fileName)!} draft={draft} onRead={onRead} />)}</>;
}

function Offer({ read, file, draft, onRead }: { read: FileRead; file: File; draft: ParseResult; onRead: (fileName: string, result: ParseResult) => void }) {
  const profile = useActiveProfile();
  const country = useSession(s => s.account?.country);
  const [open, setOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const doubtful = draft.measurements.filter(m => m.sourceFile === read.fileName && m.confidence === 'low').length;
  const why = read.found === 0
    ? 'No results could be read from it on this device.'
    : `${read.found} result${read.found === 1 ? ' was' : 's were'} read on this device${doubtful ? `, ${doubtful} of them need checking` : ''}.`;

  async function go() {
    if (!profile || !agreed) return;
    setBusy(true);
    setError(null);
    try {
      const out = await backend.extractReport(profile.id, await sendable(file), file.name);
      if (!out.isLabReport) { setError('Claude says this is not a lab report.'); setBusy(false); return; }
      const parsed = parseJsonText(JSON.stringify({ date: out.sampleDate, results: out.results }), file.name);
      if (!parsed.measurements.length) { setError('Claude could not read any results from it either.'); setBusy(false); return; }
      onRead(file.name, { ...parsed, reads: [{ fileName: file.name, method: 'claude', found: parsed.measurements.length, poor: false }] });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="ai-read" role="region" aria-label={`Read ${file.name} with Claude`}>
      <p><b>{file.name} was hard to read.</b> {why}</p>
      {!open ? (
        <button type="button" className="btn btn--small" onClick={() => setOpen(true)}>Read it with Claude…</button>
      ) : (
        <>
          <label className="confirm-check">
            <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} />
            <span>
              Send this file to Anthropic, the company that makes Claude, to read the results. It may be processed outside
              {country ? ` ${countryName(country)}` : ' your country'}, under Anthropic's terms. Only this file is sent, only now,
              and LotusPond keeps a copy only if you add the results. You check everything Claude reads before it is added.
            </span>
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="panel__actions">
            <button type="button" className="btn btn--small" onClick={() => { setOpen(false); setAgreed(false); }} disabled={busy}>Not now</button>
            <button type="button" className="btn btn--small btn--primary" disabled={!agreed || busy} onClick={() => void go()}>{busy ? 'Reading with Claude…' : 'Read with Claude'}</button>
          </div>
        </>
      )}
    </div>
  );
}
