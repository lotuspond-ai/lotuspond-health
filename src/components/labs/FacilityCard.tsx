// One facility in the list: kind icon, name, distance, open now, address, tags, and one-tap actions.
import type { CSSProperties, Ref } from 'react';
import type { Facility } from '../../types';
import { openState } from '../../../shared/opening-hours';
import { LabIcon } from './LabIcon';
import { directionsUrl, formatDistance, isPartner, KIND, shortHost, telHref } from './meta';

function Hours({ value }: { value: string | null }) {
  if (!value) return null;
  const s = openState(value);
  if (!s) return <span className="fchip fchip--hours" title={value}><LabIcon name="clock" /><span>{value}</span></span>;
  if (s.always) return <span className="fchip fchip--open"><i aria-hidden />Open 24 hours</span>;
  if (s.open) return <span className="fchip fchip--open" title={value}><i aria-hidden />Open now{s.until ? <small> · until {s.until}</small> : null}</span>;
  return <span className="fchip fchip--closed" title={value}><i aria-hidden />Closed{s.opensAt ? <small> · opens {s.opensAt}</small> : null}</span>;
}

export function FacilityCard({ f, selected, onSelect, ref }: { f: Facility; selected: boolean; onSelect: (id: string) => void; ref?: Ref<HTMLElement> }) {
  const partner = isPartner(f) ? f : null;
  const kind = KIND[f.kind];
  const tags: { icon: 'home' | 'shield' | 'siren' | 'star'; text: string }[] = [];
  if (partner?.services.includes('home_collection')) tags.push({ icon: 'home', text: 'Home collection' });
  if (partner?.accreditation) tags.push({ icon: 'shield', text: partner.accreditation });
  if (!partner && f.source === 'osm' && f.emergency) tags.push({ icon: 'siren', text: 'Emergency' });
  const address = partner ? [partner.address, partner.locality].filter(Boolean).join(', ') : f.address;
  return (
    <article ref={ref} className={`fcard${selected ? ' is-selected' : ''}${partner ? ' fcard--partner' : ''}`} style={{ '--kind': kind.color } as CSSProperties}>
      <button type="button" className="fcard__main" aria-pressed={selected} onClick={() => onSelect(f.id)}
        aria-label={`${f.name}, ${kind.label.toLowerCase()}, ${formatDistance(f.distanceKm)} away. Show on map`}>
        <span className="fcard__icon"><LabIcon name={f.kind} /></span>
        <span className="fcard__body">
          <span className="fcard__title">
            <b>{f.name}</b>
            {partner && <span className="fcard__partner"><LabIcon name="star" />Partner</span>}
          </span>
          <span className="fcard__meta">
            <span className="fchip fchip--dist"><LabIcon name="pin" />{formatDistance(f.distanceKm)}</span>
            <span className="fchip fchip--kind">{kind.label}</span>
            <Hours value={f.openingHours} />
          </span>
          {address && <span className="fcard__addr">{address}</span>}
          {tags.length > 0 && (
            <span className="fcard__tags">
              {tags.map(t => <span key={t.text} className={`ftag ftag--${t.icon}`}><LabIcon name={t.icon} />{t.text}</span>)}
            </span>
          )}
        </span>
      </button>
      <div className="fcard__actions">
        {partner?.bookingUrl && (
          <a className="btn btn--primary" href={partner.bookingUrl} target="_blank" rel="noopener noreferrer" aria-label={`Book a test at ${f.name}`}>
            <LabIcon name="book" />Book a test
          </a>
        )}
        <a className="btn btn--ink" href={directionsUrl(f.lat, f.lon)} target="_blank" rel="noopener noreferrer" aria-label={`Directions to ${f.name}`}>
          <LabIcon name="directions" />Directions
        </a>
        {f.phone && <a className="btn" href={telHref(f.phone)} aria-label={`Call ${f.name}, ${f.phone}`}><LabIcon name="phone" />Call</a>}
        {f.website && (
          <a className="btn" href={f.website} target="_blank" rel="noopener noreferrer" aria-label={`Website of ${f.name}, ${shortHost(f.website)}`}>
            <LabIcon name="globe" />Website
          </a>
        )}
      </div>
    </article>
  );
}
