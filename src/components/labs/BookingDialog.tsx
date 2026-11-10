// Booking a home sample collection, in four steps: tests (by pincode), a visit, who and where, then the
// consent notice and the booking itself. The booking carries an idempotency key tied to exactly what is being
// booked, so retrying after a dropped connection can never book twice.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, backend, errorMessage } from '../../api';
import {
  LAB_BOOKING_NOTICE_VERSION, type LabBookingInput, type LabCatalog, type LabCatalogItem, type LabOrderView, type LabPatient, type LabSlot,
} from '../../../shared/lab-bundle';
import type { Profile } from '../../types';
import { ageFrom, firstName, possessive, useActiveProfile } from '../../state/session';
import { useLab } from '../../state/lab';
import { toast } from '../../state/toast';
import { Field } from '../forms';
import { Icon } from '../ui';
import { useEscape } from '../useEscape';
import { LabIcon } from './LabIcon';
import { SlotPicker } from './SlotPicker';
import { failureText, partnerName, rupees, slotLabel } from './labFormat';
import '../../styles/lab-booking.css';

const PINCODE = /^[1-9]\d{5}$/;
const MOBILE = /^[6-9]\d{9}$/;

type Step = 'tests' | 'visit' | 'details' | 'confirm';
const STEPS: { id: Step; label: string }[] = [
  { id: 'tests', label: 'Tests' }, { id: 'visit', label: 'Visit' }, { id: 'details', label: 'Details' }, { id: 'confirm', label: 'Confirm' },
];

export function BookingDialog() {
  const open = useLab(s => s.bookingOpen);
  const profile = useActiveProfile();
  // Mounted only while open, so every booking starts fresh.
  return open && profile ? <BookingPanel profile={profile} /> : null;
}

/** "about 24 hours", "about 2 days" */
function reportTime(hours: number): string {
  if (hours < 36) return `about ${hours} hours`;
  const days = Math.round(hours / 24);
  return `about ${days} days`;
}

/** The mobile number as typed, reduced to its 10 digits (people paste +91, 0 or spaces). */
function mobileDigits(text: string): string {
  const d = text.replace(/\D/g, '');
  return d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d;
}

/** "+91 98123 45678" */
const showMobile = (digits: string) => `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;

const labSex = (s: Profile['sex']): LabPatient['sex'] | '' => (s === 'female' || s === 'male' ? s : s === 'intersex' ? 'other' : '');

function newKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}

interface Details { name: string; age: string; sex: LabPatient['sex'] | ''; phone: string; line1: string; line2: string; landmark: string; city: string }
type DetailErrors = Partial<Record<keyof Details, string>>;

function checkDetails(d: Details): DetailErrors {
  const e: DetailErrors = {};
  const name = d.name.trim();
  if (name.length < 2) e.name = 'Enter the name the lab should use.';
  else if (name.length > 100) e.name = 'Use at most 100 characters.';
  const age = Number(d.age);
  if (!d.age.trim() || !Number.isInteger(age) || age < 0 || age > 120) e.age = 'Enter the age in whole years.';
  else if (age < 18) e.age = 'Home tests are for adults (18 and over) for now.';
  if (!d.sex) e.sex = 'Choose one. Labs use it to pick reference ranges.';
  if (!MOBILE.test(mobileDigits(d.phone))) e.phone = 'Enter a 10-digit Indian mobile number.';
  if (d.line1.trim().length < 3) e.line1 = 'Enter the house and street.';
  if (d.city.trim().length < 2) e.city = 'Enter the city.';
  return e;
}

function BookingPanel({ profile }: { profile: Profile }) {
  const setOpen = useLab(s => s.setBookingOpen);
  const upsert = useLab(s => s.upsertOrder);
  const self = profile.relationship === 'self';
  const who = self ? 'your' : possessive(profile);

  const [step, setStep] = useState<Step>('tests');
  const [reached, setReached] = useState(0);
  const go = (s: Step) => { setStep(s); setReached(r => Math.max(r, STEPS.findIndex(x => x.id === s))); };

  // Tests
  const [pincode, setPincode] = useState(PINCODE.test(profile.postalCode ?? '') ? profile.postalCode! : '');
  const [catalog, setCatalog] = useState<{ status: 'idle' | 'loading' | 'error'; error?: string } | { status: 'ready'; data: LabCatalog }>({ status: 'idle' });
  const [item, setItem] = useState<LabCatalogItem | null>(null);
  // Visit
  const [slot, setSlot] = useState<LabSlot | null>(null);
  const [slotRefresh, setSlotRefresh] = useState(0);
  const [slotError, setSlotError] = useState<string | null>(null);
  // Details
  const [details, setDetails] = useState<Details>({
    name: profile.displayName, age: String(ageFrom(profile.dateOfBirth) ?? ''), sex: labSex(profile.sex),
    phone: '', line1: '', line2: '', landmark: '', city: profile.locality ?? '',
  });
  const [showErrors, setShowErrors] = useState(false);
  const errors = checkDetails(details);
  const set = (k: keyof Details) => (v: string) => setDetails(d => ({ ...d, [k]: v }));
  // Confirm
  const [agreed, setAgreed] = useState(false);
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const key = useRef<{ body: string; key: string } | null>(null);

  const close = () => { if (!booking) setOpen(false); };
  useEscape(close);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.scrollTo({ top: 0 }); }, [step]);

  const pincodeOk = PINCODE.test(pincode);
  const lookup = async (pin: string) => {
    setCatalog({ status: 'loading' });
    try {
      const data = await backend.labCatalog(pin);
      setCatalog({ status: 'ready', data });
      setItem(it => (it && data.items.some(x => x.partner === it.partner && x.code === it.code) ? it : null));
    } catch (e) {
      setCatalog({ status: 'error', error: errorMessage(e) });
    }
  };
  // Look the pincode up as soon as it is complete (and at once when the home area already has one).
  useEffect(() => {
    if (pincodeOk) void lookup(pincode);
    else setCatalog({ status: 'idle' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pincode]);

  const chooseItem = (it: LabCatalogItem) => {
    if (item?.partner !== it.partner || item.code !== it.code) { setSlot(null); setReached(0); setAgreed(false); }
    setItem(it);
  };

  const input = (): LabBookingInput | null => {
    if (!item || !slot) return null;
    const opt = (s: string) => (s.trim() ? s.trim() : undefined);
    return {
      partner: item.partner, items: [item.code], slot,
      patient: { name: details.name.trim(), age: Number(details.age), sex: details.sex as LabPatient['sex'] },
      phone: `+91${mobileDigits(details.phone)}`,
      address: { line1: details.line1.trim(), line2: opt(details.line2), landmark: opt(details.landmark), city: details.city.trim(), pincode },
      consent: { noticeVersion: LAB_BOOKING_NOTICE_VERSION, accepted: true },
    };
  };

  async function book() {
    const body = input();
    if (!body || !agreed) return;
    // The same details keep the same key, so a retry is the same booking; anything changed is a new one.
    const text = JSON.stringify(body);
    if (key.current?.body !== text) key.current = { body: text, key: newKey() };
    setBooking(true);
    setBookError(null);
    try {
      const order = await backend.bookLab(profile.id, body, key.current.key);
      upsert(order);
      setBooking(false);
      setOpen(false);
      toast.info(order.status === 'placing'
        ? `Confirming the visit with ${partnerName(order.partner)}. This page updates when they do.`
        : `Booked for ${slotLabel(order.slot ?? body.slot)}. The collector will call ${showMobile(mobileDigits(body.phone))} before the visit.`);
    } catch (e) {
      setBooking(false);
      const refused = e instanceof ApiError ? (e.detail.order as LabOrderView | undefined) : undefined;
      if (refused) upsert(refused);
      if (e instanceof ApiError && e.code === 'slot_unavailable') {
        key.current = null;
        setSlot(null);
        setSlotRefresh(n => n + 1);
        setSlotError('That visit was just taken. Pick another time.');
        go('visit');
      } else if (e instanceof ApiError && e.code === 'consent_outdated') {
        setBookError('The booking notice has changed since this app was loaded. Reload the app, then book again.');
      } else if (e instanceof ApiError && e.status === 0) {
        setBookError(`${errorMessage(e)} Trying again is safe: it will not book twice.`);
      } else {
        setBookError(refused ? failureText(refused.failureReason) : errorMessage(e));
      }
    }
  }

  const index = STEPS.findIndex(s => s.id === step);
  const next = (e?: FormEvent) => {
    e?.preventDefault();
    if (step === 'tests' && item) go('visit');
    else if (step === 'visit' && slot) go('details');
    else if (step === 'details') {
      if (Object.keys(errors).length) { setShowErrors(true); return; }
      go('confirm');
    }
  };
  const back = () => { if (index > 0) setStep(STEPS[index - 1].id); };
  const err = (k: keyof Details) => (showErrors ? errors[k] : null);
  const lab = item ? partnerName(item.partner) : 'the lab';

  return (
    <div className="scrim" onClick={close}>
      <div ref={panel} className="dialog lbook" role="dialog" aria-modal="true" aria-labelledby="lb-title" onClick={e => e.stopPropagation()}>
        <div className="dialog__head">
          <div>
            <h2 id="lb-title">Book a home test</h2>
            <p className="muted">A lab collector visits {self ? 'you' : firstName(profile)} at home to take a blood sample. Results come back here.</p>
          </div>
          <button className="btn btn--quiet x" onClick={close} aria-label="Close" disabled={booking}>{Icon.close}</button>
        </div>

        <ol className="lsteps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s.id} className={i < index ? 'is-done' : i === index ? 'is-now' : undefined} aria-current={i === index ? 'step' : undefined}>
              <button type="button" disabled={i > reached || booking} onClick={() => setStep(s.id)}>
                <i aria-hidden>{i < index ? <LabIcon name="check" /> : i + 1}</i><span>{s.label}</span>
              </button>
            </li>
          ))}
        </ol>

        {step === 'tests' && (
          <section className="lbook__step" aria-label="Tests">
            <Field label="Pincode where the sample is collected" hint="Partner labs and prices depend on the area.">
              {id => (
                <input id={id} inputMode="numeric" autoComplete="postal-code" maxLength={6} value={pincode} placeholder="560034" autoFocus={!pincodeOk}
                  onChange={e => {
                    const pin = e.target.value.replace(/\D/g, '').slice(0, 6);
                    if (pin !== pincode) { setPincode(pin); setSlot(null); setReached(0); setAgreed(false); }
                  }} />
              )}
            </Field>
            {catalog.status === 'loading' && <div className="lpkgs" aria-busy="true" aria-label="Finding tests">{[0, 1, 2].map(i => <span key={i} className="lpkg lpkg--skel" />)}</div>}
            {catalog.status === 'error' && (
              <p className="form-error" role="alert">{catalog.error} <button type="button" className="btn btn--quiet" onClick={() => void lookup(pincode)}>Try again</button></p>
            )}
            {catalog.status === 'ready' && (
              <>
                {catalog.data.unavailable.length > 0 && (
                  <p className="lnotice" role="status"><LabIcon name="cloudOff" />{catalog.data.unavailable.map(partnerName).join(' and ')} did not answer just now, so {catalog.data.unavailable.length > 1 ? 'their' : 'its'} tests are missing.</p>
                )}
                {catalog.data.items.length === 0 ? (
                  <p className="lslots__none">No partner lab collects at {catalog.data.pincode} yet. You can still find labs near you to visit.</p>
                ) : (
                  <div className="lpkgs" role="radiogroup" aria-label="Test package">
                    {[...catalog.data.items].sort((a, b) => a.pricePaise - b.pricePaise).map(it => {
                      const on = item?.partner === it.partner && item.code === it.code;
                      return (
                        <button key={`${it.partner}:${it.code}`} type="button" role="radio" aria-checked={on} className="lpkg" onClick={() => chooseItem(it)}>
                          <span className="lpkg__top">
                            <b>{it.name}</b>
                            <span className="lpkg__price">{it.mrpPaise && it.mrpPaise > it.pricePaise && <s>{rupees(it.mrpPaise)}</s>}{rupees(it.pricePaise)}</span>
                          </span>
                          <span className="lpkg__tests">
                            {it.tests.length} test{it.tests.length === 1 ? '' : 's'}: {it.tests.slice(0, 5).join(', ')}{it.tests.length > 5 ? ` and ${it.tests.length - 5} more` : ''}
                          </span>
                          <span className="lpkg__meta">
                            <span>{partnerName(it.partner)}</span>
                            <span><LabIcon name="clock" />Report in {reportTime(it.reportHours)}</span>
                            {it.fasting && <span className="lpkg__fast">Fasting</span>}
                          </span>
                          <span className="lpkg__tick" aria-hidden><LabIcon name="check" /></span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {step === 'visit' && item && (
          <section className="lbook__step" aria-label="Visit">
            <p className="lbook__lede">When should {lab} come? Times are India time.</p>
            {slotError && <p className="warn" role="alert">{slotError}</p>}
            <SlotPicker key={`${item.partner}:${item.code}:${pincode}`} fasting={item.fasting} value={slot} refreshKey={slotRefresh}
              onChange={s => { setSlot(s); setSlotError(null); }}
              load={date => backend.labSlots({ partner: item.partner, pincode, date, items: [item.code] })} />
          </section>
        )}

        {step === 'details' && (
          <form className="lbook__step" aria-label="Details" onSubmit={next} noValidate>
            <h3 className="lbook__h">Who is being tested</h3>
            <div className="form-grid">
              <Field label="Name for the lab" error={err('name')} wide>
                {id => <input id={id} value={details.name} autoComplete={self ? 'name' : 'off'} onChange={e => set('name')(e.target.value)} />}
              </Field>
              <Field label="Age" error={err('age')}>
                {id => <input id={id} inputMode="numeric" value={details.age} onChange={e => set('age')(e.target.value.replace(/\D/g, '').slice(0, 3))} />}
              </Field>
              <Field label="Sex" error={err('sex')}>
                {id => (
                  <div className="seg seg--form" role="radiogroup" id={id}>
                    {(['female', 'male', 'other'] as const).map(s => (
                      <button key={s} type="button" role="radio" aria-checked={details.sex === s} aria-pressed={details.sex === s} onClick={() => set('sex')(s)}>
                        {s === 'female' ? 'Female' : s === 'male' ? 'Male' : 'Other'}
                      </button>
                    ))}
                  </div>
                )}
              </Field>
            </div>
            <h3 className="lbook__h">Where the collector comes</h3>
            <div className="form-grid">
              <Field label="Mobile number" hint="The collector calls this number before the visit." error={err('phone')} wide>
                {id => (
                  <div className="unit lbook__phone"><span>+91</span>
                    <input id={id} type="tel" inputMode="tel" autoComplete={self ? 'tel-national' : 'off'} value={details.phone} placeholder="98123 45678"
                      onChange={e => set('phone')(e.target.value.slice(0, 16))} />
                  </div>
                )}
              </Field>
              <Field label="House and street" error={err('line1')} wide>
                {id => <input id={id} autoComplete="address-line1" value={details.line1} onChange={e => set('line1')(e.target.value)} />}
              </Field>
              <Field label="Area (optional)">
                {id => <input id={id} autoComplete="address-line2" value={details.line2} onChange={e => set('line2')(e.target.value)} />}
              </Field>
              <Field label="Landmark (optional)">
                {id => <input id={id} value={details.landmark} placeholder="Near the temple" onChange={e => set('landmark')(e.target.value)} />}
              </Field>
              <Field label="City" error={err('city')}>
                {id => <input id={id} autoComplete="address-level2" value={details.city} onChange={e => set('city')(e.target.value)} />}
              </Field>
              <Field label="Pincode" hint={<button type="button" className="linkish" onClick={() => setStep('tests')}>Change</button>}>
                {id => <input id={id} value={pincode} readOnly aria-readonly />}
              </Field>
            </div>
            {/* Lets Enter submit the step. */}
            <button type="submit" hidden />
          </form>
        )}

        {step === 'confirm' && item && slot && (
          <section className="lbook__step" aria-label="Confirm">
            <dl className="lsummary">
              <div><dt>Tests</dt><dd>{item.name}<small>{partnerName(item.partner)}</small></dd></div>
              <div><dt>Visit</dt><dd>{slotLabel(slot)}<small>{item.fasting ? 'Fasting: nothing but water for 10 to 12 hours before' : 'No fasting needed'}</small></dd></div>
              <div><dt>For</dt><dd>{details.name.trim()}<small>{details.age} years, {details.sex}</small></dd></div>
              <div><dt>At</dt><dd>{[details.line1, details.line2, details.landmark].map(s => s.trim()).filter(Boolean).join(', ')}<small>{details.city.trim()} {pincode} · {showMobile(mobileDigits(details.phone))}</small></dd></div>
              <div><dt>Price</dt><dd>{rupees(item.pricePaise)}<small>Paid to the collector at the visit</small></dd></div>
            </dl>
            <div className="lconsent">
              <h3><LabIcon name="shield" />What is shared with {lab}</h3>
              <p>
                To collect the sample and run the tests, LotusPond sends {lab} the name, age and sex above, the mobile number, the address and the tests
                chosen. {lab} sends the results back to LotusPond, and you check them here before they are added to {who} records.
                Nothing else from {who} records is shared.
              </p>
              {!self && <p>Book for {firstName(profile)} only with their agreement.</p>}
              <label className="lconsent__check">
                <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} />
                <span>I agree to share these details with {lab} for this booking.</span>
              </label>
            </div>
            {bookError && <p className="form-error" role="alert">{bookError}</p>}
          </section>
        )}

        <div className="tools dialog__actions">
          {index > 0 && <button type="button" className="btn" onClick={back} disabled={booking}>Back</button>}
          {step !== 'confirm' && (
            <button type="button" className="btn btn--primary" onClick={() => next()}
              disabled={(step === 'tests' && !item) || (step === 'visit' && !slot)}>
              {step === 'tests' && item ? `Continue with ${rupees(item.pricePaise)}` : 'Continue'}
            </button>
          )}
          {step === 'confirm' && (
            <button type="button" className="btn btn--primary" onClick={() => void book()} disabled={!agreed || booking}>
              {booking ? 'Booking…' : `Book the visit`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
