// Checking a lab's results before they join the records: the values the lab sent, read by the same parser as an
// uploaded file and shown in the same review table, so anything can be corrected or left out first.
import { useEffect, useState } from 'react';
import { backend, errorMessage } from '../../api';
import type { LabResultView } from '../../../shared/lab-bundle';
import type { Measurement, MeasurementInput, ParseResult } from '../../types';
import { parseFile, parseJsonText } from '../../lib/parse';
import { refreshMeasurement } from '../../lib/status';
import { formatDate } from '../../lib/derive';
import { useHealth } from '../../lib/store';
import { isNative } from '../../native/platform';
import { useLab } from '../../state/lab';
import { possessive, useActiveProfile } from '../../state/session';
import { toast } from '../../state/toast';
import { ConfirmButton } from '../forms';
import { Icon } from '../ui';
import { ReviewTable } from '../Overlays';
import { useEscape } from '../useEscape';
import { LabIcon } from './LabIcon';
import { partnerName } from './labFormat';
import '../../styles/lab-booking.css';

export function ResultReview() {
  const id = useLab(s => s.reviewing);
  const result = useLab(s => s.results.find(r => r.id === s.reviewing && r.status === 'pending'));
  // Keyed by result, so each review starts from what the lab sent.
  return id && result ? <ReviewPanel key={id} result={result} /> : null;
}

const withoutId = ({ id: _id, ...rest }: Measurement): MeasurementInput => rest;

async function read(result: LabResultView): Promise<ParseResult> {
  if (result.bundle) return parseJsonText(JSON.stringify(result.bundle), result.source);
  if (result.hasPdf) {
    const blob = await backend.labReport(result.profileId, result.id);
    return parseFile(new File([blob], `${result.source}.pdf`, { type: 'application/pdf' }));
  }
  return { measurements: [], scans: [], blobs: {}, warnings: ['The lab sent no values that could be read.'], detectedDate: null };
}

function ReviewPanel({ result: initial }: { result: LabResultView }) {
  // The list refreshes every few seconds; the review works from the copy it opened with.
  const [result] = useState(initial);
  const profile = useActiveProfile();
  const setReviewing = useLab(s => s.setReviewing);
  const order = useLab(s => s.orders.find(o => o.id === result.orderId));
  const [draft, setDraft] = useState<ParseResult | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const who = profile?.relationship === 'self' ? 'your' : possessive(profile);
  const lab = partnerName(result.bundle?.source.partner ?? order?.partner ?? '');
  const close = () => { if (!saving) setReviewing(null); };
  useEscape(close);

  useEffect(() => {
    let alive = true;
    read(result).then(r => { if (alive) setDraft(r); }, e => { if (alive) setReadError(errorMessage(e)); });
    return () => { alive = false; };
  }, [result]);

  const patch = (id: string, p: Partial<Measurement>) => setDraft(d => d && { ...d, measurements: d.measurements.map(m => (m.id === id ? { ...m, ...p } : m)) });
  const drop = (id: string) => setDraft(d => d && { ...d, measurements: d.measurements.filter(m => m.id !== id) });

  async function save(d: ParseResult) {
    setSaving(true);
    setSaveError(null);
    try {
      const done = await backend.saveLabResult(result.profileId, result.id, d.measurements.map(refreshMeasurement).map(withoutId));
      // The server added the records (and the report as a file); show them.
      if (useHealth.getState().profileId === result.profileId) await useHealth.getState().openProfile(result.profileId);
      void useLab.getState().refresh();
      setSaving(false);
      setReviewing(null);
      const n = done.saved;
      toast.info(`${n ? `Added ${n} result${n === 1 ? '' : 's'}` : 'Added the report'} to ${who} records${done.replaced ? `, in place of ${done.replaced} from the earlier report` : ''}.`);
    } catch (e) {
      setSaving(false);
      setSaveError(`Nothing was added. ${errorMessage(e)}`);
    }
  }

  async function dismiss() {
    try {
      await backend.dismissLabResult(result.profileId, result.id);
      void useLab.getState().refresh();
      setReviewing(null);
      toast.info(`These results were not added to ${who} records.`);
    } catch (e) {
      setSaveError(errorMessage(e));
    }
  }

  async function shareReport() {
    setOpening(true);
    try {
      const { shareBlob } = await import('../../native/share');
      await shareBlob(await backend.labReport(result.profileId, result.id), `${result.source}.pdf`, `${lab} report`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setOpening(false);
    }
  }

  const reportUrl = result.hasPdf ? backend.labReportUrl(result.profileId, result.id) : null;
  const count = draft?.measurements.length ?? 0;
  const collected = result.bundle?.date ? formatDate(result.bundle.date) : null;

  return (
    <div className="scrim" onClick={close}>
      <div className="dialog dialog--upload lreview" role="dialog" aria-modal="true" aria-labelledby="lr-title" onClick={e => e.stopPropagation()}>
        <div className="dialog__head">
          <div>
            <h2 id="lr-title">Check the results</h2>
            <p className="muted">
              From {lab}{collected ? `, sample collected ${collected}` : ''}. Edit anything that looks wrong or remove it, then add the rest to {who} records.
            </p>
          </div>
          <button className="btn btn--quiet x" onClick={close} aria-label="Close" disabled={saving}>{Icon.close}</button>
        </div>

        {result.partial && (
          <p className="lnotice" role="status"><LabIcon name="clock" />The lab has sent some results and is still running the rest. Add these now if you like: the full report replaces them when it comes.</p>
        )}
        {readError && <p className="form-error" role="alert">These results could not be read. {readError}</p>}
        {!draft && !readError && <div className="lreview__loading" role="status">Reading the results…</div>}
        {draft && (
          <>
            {draft.warnings.map(w => <p key={w} className="warn">{w}</p>)}
            {count > 0 && <ReviewTable measurements={draft.measurements} onPatch={patch} onDrop={drop} />}
            {count === 0 && <p className="lede">No values are left to add.{result.hasPdf ? ' The report itself can still be added to the files.' : ''}</p>}
          </>
        )}
        {saveError && <p className="form-error" role="alert">{saveError}</p>}

        <div className="tools dialog__actions lreview__actions">
          {result.hasPdf && (reportUrl
            ? <a className="btn btn--quiet" href={reportUrl} target="_blank" rel="noopener">{Icon.file} Open the report</a>
            : isNative && <button type="button" className="btn btn--quiet" disabled={opening} onClick={() => void shareReport()}>{Icon.file} {opening ? 'Opening…' : 'Open the report'}</button>)}
          <span className="spacer" />
          <ConfirmButton className="btn btn--quiet btn--danger-text" confirmText="Leave these results out of the records?" busyText="Leaving out…" onConfirm={dismiss}>
            Don’t add
          </ConfirmButton>
          <button type="button" className="btn btn--primary" disabled={!draft || saving || (count === 0 && !result.hasPdf)} onClick={() => draft && void save(draft)}>
            {saving ? 'Adding…' : count ? `Add ${count} result${count === 1 ? '' : 's'}` : 'Add the report'}
          </button>
        </div>
      </div>
    </div>
  );
}
