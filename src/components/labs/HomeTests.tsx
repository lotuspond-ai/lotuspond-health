// Find a lab → Home collection: book a lab visit at home, follow it from booking to report, move or cancel it,
// and check the results before they are added to the records.
import { useState } from 'react';
import { ApiError, backend, errorMessage } from '../../api';
import type { LabOrderView, LabResultView, LabSlot } from '../../../shared/lab-bundle';
import { useLab } from '../../state/lab';
import { firstName, useActiveProfile } from '../../state/session';
import { toast } from '../../state/toast';
import { useUI } from '../../state/ui';
import { ConfirmButton } from '../forms';
import { EmptyState } from './Illustration';
import { LabIcon } from './LabIcon';
import { SlotPicker } from './SlotPicker';
import { STATUS_LABEL, STEPS, failureText, partnerName, rupees, slotLabel, statusTone, stepOf } from './labFormat';
import '../../styles/lab-booking.css';

const FINISHED = new Set<LabOrderView['status']>(['delivered', 'cancelled', 'failed', 'expired']);

export function HomeTests() {
  const profile = useActiveProfile();
  const { orders, results, status, error, retry, setBookingOpen } = useLab();
  const self = profile?.relationship === 'self';
  const who = self ? 'your' : `${firstName(profile)}’s`;
  const pending = results.filter(r => r.status === 'pending');
  const resultFor = (o: LabOrderView) => pending.find(r => r.orderId === o.id);
  // Orders with results to check first, then what the lab is working on, then the rest.
  const rank = (o: LabOrderView) => (resultFor(o) ? 0 : FINISHED.has(o.status) ? 2 : 1);
  const current = orders.filter(o => rank(o) < 2).sort((a, b) => rank(a) - rank(b));
  const earlier = orders.filter(o => rank(o) === 2);
  const orphans = pending.filter(r => !orders.some(o => o.id === r.orderId));

  return (
    <div className="hometests">
      <header className="labs__head">
        <div>
          <h1>Home tests</h1>
          <p className="labs__sub">A lab collects a sample at home. You check the results before they join {who} records.</p>
        </div>
        {orders.length > 0 && (
          <button type="button" className="btn btn--primary hometests__book" onClick={() => setBookingOpen(true)}>
            {<LabIcon name="book" />}Book a home test
          </button>
        )}
      </header>

      {(status === 'loading' || status === 'idle') && (
        <div className="fskel" role="status" aria-label="Loading home tests">{[0, 1].map(i => <div key={i} className="fskel__card"><i /><span><b /><em /><em /></span></div>)}</div>
      )}

      {status === 'error' && (
        <EmptyState variant="offline" title="Home tests could not be loaded" action={<button type="button" className="btn btn--primary" onClick={() => void retry()}>Try again</button>}>
          {error}
        </EmptyState>
      )}

      {status === 'ready' && orders.length === 0 && orphans.length === 0 && (
        <EmptyState variant="find" title="Get tested without leaving home"
          action={<button type="button" className="btn btn--primary" onClick={() => setBookingOpen(true)}><LabIcon name="book" />Book a home test</button>}>
          Choose a test package for your pincode and a time. A collector from a partner lab comes to take the sample, and the results come back here.
        </EmptyState>
      )}

      {status === 'ready' && (orders.length > 0 || orphans.length > 0) && (
        <>
          {orphans.map(r => <ReadyBanner key={r.id} result={r} />)}
          {current.length > 0 && (
            <section className="lgroup" aria-label="Current bookings">
              <h2>Current</h2>
              <ul className="lorders">{current.map(o => <OrderCard key={o.id} order={o} result={resultFor(o)} />)}</ul>
            </section>
          )}
          {earlier.length > 0 && (
            <section className="lgroup" aria-label="Earlier bookings">
              <h2>Earlier</h2>
              <ul className="lorders">{earlier.map(o => <OrderCard key={o.id} order={o} result={resultFor(o)} />)}</ul>
            </section>
          )}
          <p className="lattrib">LotusPond shares only what each booking needs, and only with the lab you choose.</p>
        </>
      )}
    </div>
  );
}

function ReadyBanner({ result }: { result: LabResultView }) {
  const setReviewing = useLab(s => s.setReviewing);
  return (
    <div className="lready" role="status">
      <span className="lready__icon"><LabIcon name="check" /></span>
      <span className="lready__text"><b>{result.partial ? 'Some results are ready' : 'Results are ready'}</b><small>{result.source}</small></span>
      <button type="button" className="btn btn--primary" onClick={() => setReviewing(result.id)}>Check and add</button>
    </div>
  );
}

const NOTE: Partial<Record<LabOrderView['status'], string>> = {
  placing: 'Confirming the visit with the lab. This usually takes under a minute.',
  booked: 'The lab assigns a collector before the visit.',
  collector_assigned: 'A collector is assigned and will call before the visit.',
  sample_collected: 'The sample is on its way to the lab.',
  recollection_needed: 'The lab needs a new sample. They will call to arrange another visit.',
  processing: 'The lab is testing the sample.',
  partial_report: 'Some results are in. The rest follow when the lab finishes.',
  expired: 'No sample was collected before this booking expired.',
};

function OrderCard({ order, result }: { order: LabOrderView; result?: LabResultView }) {
  const upsert = useLab(s => s.upsertOrder);
  const setReviewing = useLab(s => s.setReviewing);
  const setView = useUI(s => s.setView);
  const [moving, setMoving] = useState(false);
  const tone = statusTone(order.status);
  const step = stepOf(order);
  const names = order.items.map(i => i.name).join(', ');

  const cancel = async () => {
    try {
      const o = await backend.cancelLabOrder(order.profileId, order.id);
      upsert(o);
      toast.info('The booking is cancelled.');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <li className={`lorder lorder--${tone}`} data-order={order.id}>
      <div className="lorder__head">
        <span className="lorder__icon"><LabIcon name="lab" /></span>
        <span className="lorder__title">
          <b>{names}</b>
          <small>{partnerName(order.partner)}{order.partnerRef ? ` · Ref ${order.partnerRef}` : ''}</small>
        </span>
        <span className={`lstatus lstatus--${tone}`}>
          {order.status === 'placing' && <LabIcon name="spinner" className="spin" />}
          {result ? (result.partial ? 'Some results ready' : 'Results ready') : STATUS_LABEL[order.status]}
        </span>
      </div>

      <dl className="lorder__facts">
        {order.slot && <div><dt>Visit</dt><dd>{slotLabel(order.slot)}</dd></div>}
        <div><dt>Price</dt><dd>{rupees(order.pricePaise)}{order.payer === 'partner' && order.status !== 'delivered' && !FINISHED.has(order.status) ? ', paid at the visit' : ''}</dd></div>
      </dl>

      {step >= 0 && <Tracker step={step} complete={order.status === 'delivered'} />}

      {order.status === 'failed' && <p className="lorder__note lorder__note--stopped">{failureText(order.failureReason)} Nothing was booked.</p>}
      {order.status === 'recollection_needed' && <p className="lorder__note lorder__note--attention">{NOTE.recollection_needed}</p>}
      {order.status !== 'recollection_needed' && !result && NOTE[order.status] && <p className="lorder__note">{NOTE[order.status]}</p>}

      {result && (
        <div className="lorder__ready">
          <span>{result.partial ? 'The first results are here.' : 'The report is here.'} Check the values, then add them to the records.</span>
          <button type="button" className="btn btn--primary" onClick={() => setReviewing(result.id)}>Check and add</button>
        </div>
      )}

      {order.status === 'delivered' && !result && (
        <div className="lorder__ready lorder__ready--done">
          <span><LabIcon name="check" />The results are in the records.</span>
          <button type="button" className="btn" onClick={() => setView('markers')}>See results</button>
        </div>
      )}

      {moving && <Reschedule order={order} onDone={() => setMoving(false)} />}

      {!moving && (order.canReschedule || order.canCancel) && (
        <div className="lorder__actions">
          {order.canReschedule && <button type="button" className="btn btn--quiet" onClick={() => setMoving(true)}><LabIcon name="clock" />Move the visit</button>}
          {order.canCancel && (
            <ConfirmButton className="btn btn--quiet btn--danger-text" confirmText="Cancel this booking?" busyText="Cancelling…" onConfirm={cancel}>
              Cancel booking
            </ConfirmButton>
          )}
        </div>
      )}
    </li>
  );
}

function Tracker({ step, complete }: { step: number; complete: boolean }) {
  return (
    <ol className="ltrack" aria-label="Progress">
      {STEPS.map((s, i) => {
        const done = i < step || complete;
        return (
          <li key={s} className={done ? 'is-done' : i === step ? 'is-now' : undefined} aria-current={!complete && i === step ? 'step' : undefined}>
            <i aria-hidden>{done && <LabIcon name="check" />}</i><span>{s}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Reschedule({ order, onDone }: { order: LabOrderView; onDone: () => void }) {
  const upsert = useLab(s => s.upsertOrder);
  const [slot, setSlot] = useState<LabSlot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  const move = async () => {
    if (!slot) return;
    setBusy(true);
    setError(null);
    try {
      const o = await backend.rescheduleLabOrder(order.profileId, order.id, slot);
      upsert(o);
      toast.info(`The visit is now ${slotLabel(o.slot ?? slot)}.`);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.code === 'slot_unavailable') { setSlot(null); setRefresh(n => n + 1); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lmove">
      <h3>Move the visit{order.slot ? <small> from {slotLabel(order.slot)}</small> : null}</h3>
      <SlotPicker load={date => backend.labOrderSlots(order.profileId, order.id, date)} current={order.slot} value={slot} onChange={setSlot} refreshKey={refresh} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="tools">
        <button type="button" className="btn" onClick={onDone} disabled={busy}>Keep the visit</button>
        <button type="button" className="btn btn--primary" onClick={() => void move()} disabled={!slot || busy}>{busy ? 'Moving…' : 'Move it here'}</button>
      </div>
    </div>
  );
}
