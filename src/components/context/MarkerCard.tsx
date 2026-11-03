// A marker's latest result as a card: value, status, position in range and trend. Opens the marker drawer.
import { useHealth } from '../../lib/store';
import { formatDate, STATUS_WORD, type Series } from '../../lib/derive';
import { displayMeasurement } from '../../lib/units';
import { useUnitSystem } from '../../state/session';
import { RangeBar, Sparkline, StatusChip } from '../ui';
import { rangeText } from './summary';

export function MarkerCard({ s, compact = false }: { s: Series; compact?: boolean }) {
  const selectMarker = useHealth(st => st.selectMarker);
  const m = s.latest;
  const d = displayMeasurement(m, useUnitSystem());
  const n = s.points.length;
  const label = `${s.name}: ${d.text} ${d.unit}, ${STATUS_WORD[m.status]}${d.range ? `, range ${rangeText(d.range)}` : ''}, ${formatDate(m.date)}${n > 1 ? `, ${n} results` : ''}`;
  if (compact) {
    return (
      <button type="button" className={`mcard mcard--compact mcard--${m.status}`} onClick={() => selectMarker(s.key)} aria-label={label}>
        <span className="mcard__name">{s.name}</span>
        <span className="mcard__row">
          <span className="mval mval--sm"><b>{d.text}</b>{d.unit && <small>{d.unit}</small>}</span>
          <Sparkline points={s.points} width={56} height={22} />
        </span>
        <RangeBar m={m} />
        <StatusChip status={m.status} size="sm" />
      </button>
    );
  }
  return (
    <button type="button" className={`mcard mcard--${m.status}`} onClick={() => selectMarker(s.key)} aria-label={label}>
      <span className="mcard__top">
        <span className="mcard__name">{s.name}</span>
        <StatusChip status={m.status} size="sm" />
      </span>
      <span className="mcard__row">
        <span className="mval"><b>{d.text}</b>{d.unit && <small>{d.unit}</small>}</span>
        <Sparkline points={s.points} width={84} height={30} />
      </span>
      <RangeBar m={m} labels />
      <span className="mcard__foot">
        <span>{formatDate(m.date)}</span>
        <span>{m.range?.source === 'typical' ? 'Typical range' : n > 1 ? `${n} results` : '1 result'}</span>
      </span>
    </button>
  );
}
