// The sign-up questions that depend on where the person lives: country of residence, age, and consent.
// The same rules run in the browser (to explain early) and on the server (to decide): shared/regions.ts signUpProblem().
import { useId, type ReactNode } from 'react';
import { countryInSentence, countryPolicy, REGIONS, type DataRegion, type SignUpProblem } from '../../shared/regions';
import type { SignUpDraft } from '../lib/signup';
import { CountrySelect } from './CountrySelect';
import '../styles/compliance.css';

function Check({ checked, onChange, children, detail, error, optional }: {
  checked: boolean; onChange: (v: boolean) => void; children: ReactNode; detail?: ReactNode; error?: string | null; optional?: boolean;
}) {
  const id = useId();
  return (
    <div className={`consent${error ? ' has-error' : ''}`}>
      <input id={id} type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
        aria-describedby={detail || error ? `${id}-d` : undefined} aria-invalid={error ? true : undefined} />
      <label htmlFor={id}>
        <span className="consent__title">{children}{optional && <em> Optional</em>}</span>
      </label>
      {(detail || error) && (
        <div id={`${id}-d`} className="consent__detail">
          {detail}
          {error && <p className="field__error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}

export function SignUpDetails({ value, onChange, servedRegions, problem }: {
  value: SignUpDraft;
  onChange: (next: SignUpDraft) => void;
  servedRegions: readonly DataRegion[];
  /** Shown next to its field after a submit attempt. */
  problem: SignUpProblem | null;
}) {
  const countryId = useId();
  const noteId = useId();
  const patch = (p: Partial<SignUpDraft>) => onChange({ ...value, ...p });
  const policy = value.country ? countryPolicy(value.country) : null;
  const name = value.country ? countryInSentence(value.country) : '';
  const served = !!policy && servedRegions.includes(policy.region);
  const errorFor = (field: SignUpProblem['field']) => (problem?.field === field ? problem.message : null);
  const storage = policy ? REGIONS[policy.region].storage : '';

  return (
    <div className="signup">
      <div className={`field${!policy && errorFor('country') ? ' has-error' : ''}`}>
        <label htmlFor={countryId}>Country you live in</label>
        <CountrySelect id={countryId} value={value.country} describedBy={noteId}
          invalid={!!errorFor('country')}
          onChange={code => patch({ country: code, crossBorder: false })} />
        <div id={noteId} aria-live="polite">
          {!policy && (errorFor('country')
            ? <p className="field__error" role="alert">{errorFor('country')}</p>
            : <p className="field__hint">This decides where your records are stored and which privacy laws protect them.</p>)}
          {policy && !policy.available && (
            <div className="residency residency--blocked" role="status">
              <b>LotusPond Health is not available in {name} yet.</b>
              <p>{policy.unavailableReason}</p>
            </div>
          )}
          {policy?.available && !served && (
            <div className="residency residency--blocked" role="status">
              <b>This server cannot hold records for people in {name}.</b>
              <p>LotusPond keeps them on {storage}. Sign up through LotusPond Health for your region.</p>
            </div>
          )}
          {policy?.available && served && (
            <p className="residency">
              {policy.crossBorder ? <>Records for people in {name} are stored on {storage}.</> : <>Your records will be stored on {storage}.</>}
            </p>
          )}
        </div>
      </div>

      {policy?.available && served && (
        <>
          <fieldset className={`field age${errorFor('age') && value.age === '' ? ' has-error' : ''}`}>
            <legend>Are you {policy.minAge} or older?</legend>
            <div className="choices">
              {(['yes', 'no'] as const).map(a => (
                <label key={a} className="choice">
                  <input type="radio" name="signup-age" value={a} checked={value.age === a} onChange={() => patch({ age: a })} />
                  <span>{a === 'yes' ? 'Yes' : 'No'}</span>
                </label>
              ))}
            </div>
            {value.age === 'no' ? (
              <div className="residency residency--blocked" role="status">
                <b>You need to be {policy.minAge} or older to have your own account.</b>
                <p>A parent or guardian can add you as a family member on their account. They keep your records there, and you can use them together.</p>
              </div>
            ) : errorFor('age') ? <p className="field__error" role="alert">{errorFor('age')}</p> : null}
          </fieldset>

          {value.age !== 'no' && (
            <fieldset className="consents">
              <legend>Your consent</legend>
              <Check checked={value.termsAndPrivacy} onChange={v => patch({ termsAndPrivacy: v })} error={errorFor('termsAndPrivacy')}>
                I agree to the <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and the <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.
              </Check>
              <Check checked={value.healthData} onChange={v => patch({ healthData: v })} error={errorFor('healthData')}
                detail={<p>This covers the lab reports, scans and results you add, and the health details you enter for you and your family. LotusPond uses them only to keep your records and show them to you. We never sell them or share them.</p>}>
                I consent to LotusPond processing my health data.
              </Check>
              {policy.crossBorder && (
                <Check checked={value.crossBorder} onChange={v => patch({ crossBorder: v })} error={errorFor('crossBorder')}
                  detail={<p>LotusPond keeps records for people in {name} on {storage}. That is outside {name}, so we ask first.</p>}>
                  I agree to my records being stored on {storage}.
                </Check>
              )}
              <Check checked={value.marketing} onChange={v => patch({ marketing: v })} optional
                detail={<p>An email a few times a year about new features. You can stop it on your Account page.</p>}>
                Send me news about LotusPond.
              </Check>
            </fieldset>
          )}
        </>
      )}
    </div>
  );
}
