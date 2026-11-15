// Choosing a collection visit: a row of days, then the times the lab has free that day (in India time).
import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../../api';
import type { LabSlot } from '../../../shared/lab-bundle';
import { LabIcon } from './LabIcon';
import { nextDays, timeRange } from './labFormat';

const same = (a: LabSlot | null | undefined, b: LabSlot | null | undefined) => !!a && !!b && a.start === b.start && a.end === b.end;

type Loaded = { date: string; status: 'loading' } | { date: string; status: 'ready'; slots: LabSlot[] } | { date: string; status: 'error'; error: string };

export function SlotPicker({ load, value, onChange, current, refreshKey = 0, fasting }: {
  /** The free visits on a day (yyyy-mm-dd, India time). */
  load: (date: string) => Promise<LabSlot[]>;
  value: LabSlot | null;
  onChange: (slot: LabSlot | null) => void;
  /** The visit already booked, when moving it: shown, but not offered. */
  current?: LabSlot | null;
  /** Bump to ask the lab again (for example after a slot was taken). */
  refreshKey?: number;
  fasting?: boolean;
}) {
  const days = useMemo(() => nextDays(7), []);
  const [date, setDate] = useState(days[0].date);
  // Until a day is picked by hand, skip forward past days with nothing left (late evening, Sundays).
  const [auto, setAuto] = useState(true);
  const [loaded, setLoaded] = useState<Loaded>({ date: days[0].date, status: 'loading' });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoaded({ date, status: 'loading' });
    load(date).then(
      slots => {
        if (!alive) return;
        const open = slots.filter(s => !same(s, current));
        const i = days.findIndex(d => d.date === date);
        if (auto && !open.length && i >= 0 && i < days.length - 1) { setDate(days[i + 1].date); return; }
        setLoaded({ date, status: 'ready', slots: open });
      },
      e => { if (alive) setLoaded({ date, status: 'error', error: errorMessage(e) }); },
    );
    return () => { alive = false; };
    // `load` and `current` are fixed for a picker's life; asking again on every render would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, refreshKey, retry]);

  const pick = (d: string) => { setAuto(false); setDate(d); if (value && !value.start.startsWith(d)) onChange(null); };
  const slots = loaded.status === 'ready' && loaded.date === date ? loaded.slots : null;

  return (
    <div className="lslots">
      <div className="ldays" role="group" aria-label="Day">
        {days.map(d => (
          <button key={d.date} type="button" aria-pressed={d.date === date} onClick={() => pick(d.date)}>
            {d.label}
          </button>
        ))}
      </div>
      {fasting && <p className="lslots__hint"><LabIcon name="clock" />These tests need fasting: nothing but water for 10 to 12 hours. An early visit makes that easier.</p>}
      {loaded.status === 'loading' && <div className="lslots__grid" aria-busy="true" aria-label="Finding free visits">{[0, 1, 2, 3, 4, 5].map(i => <span key={i} className="lslots__skel" />)}</div>}
      {loaded.status === 'error' && (
        <p className="form-error" role="alert">{loaded.error} <button type="button" className="btn btn--quiet" onClick={() => setRetry(n => n + 1)}>Try again</button></p>
      )}
      {slots && slots.length === 0 && <p className="lslots__none">No visits are free that day. Try another day.</p>}
      {slots && slots.length > 0 && (
        <div className="lslots__grid" role="radiogroup" aria-label="Time">
          {slots.map(s => (
            <button key={s.start} type="button" role="radio" aria-checked={same(s, value)} onClick={() => onChange(s)}>{timeRange(s)}</button>
          ))}
        </div>
      )}
    </div>
  );
}
