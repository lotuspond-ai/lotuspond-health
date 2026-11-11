// Upload dialog, in the iOS and Android apps: import readings from Apple Health or Health Connect
// (docs/health-import.md). The person picks what to read and from when; the phone asks its own permission; the
// readings become one value per day and go to the same review as an uploaded report, where nothing is saved until
// the person presses Add.
import { useState } from 'react';
import { useHealth } from '../lib/store';
import {
  dailyValues, daysBefore, IMPORT_KINDS, importStart, importSummary, localDay, onlyNewDays, SOURCE_NAME, toMeasurements,
  type HealthReadType,
} from '../lib/health-import';
import type { HealthStore } from '../native/health';
import { firstName, useActiveProfile } from '../state/session';
import type { ParseResult } from '../types';
import '../styles/agents.css';

type Period = 'since_last' | '30' | '90' | '365';
const PERIODS: { id: Exclude<Period, 'since_last'>; label: string }[] = [
  { id: '30', label: 'Last 30 days' }, { id: '90', label: 'Last 3 months' }, { id: '365', label: 'Last year' },
];

export function HealthImportPanel({ store, onDraft, onCancel }: { store: HealthStore; onDraft: (d: ParseResult) => void; onCancel: () => void }) {
  const name = SOURCE_NAME[store.source];
  const profile = useActiveProfile();
  const existing = useHealth(s => s.measurements);
  const [today] = useState(() => localDay(new Date().toISOString())!);
  const imported = existing.some(m => m.sourceFile === name);
  const [types, setTypes] = useState<Set<HealthReadType>>(() => new Set(IMPORT_KINDS.map(k => k.type)));
  const [period, setPeriod] = useState<Period>(imported ? 'since_last' : '90');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canOpenSettings, setCanOpenSettings] = useState(false);
  const other = profile && profile.relationship !== 'self';

  async function go() {
    setError(null);
    setCanOpenSettings(false);
    setBusy(`Opening ${name}…`);
    try {
      const avail = await store.available();
      if (!avail.available) {
        setBusy(null);
        setCanOpenSettings(!!store.openSettings);
        setError(store.source === 'health_connect'
          ? `Health Connect isn’t ready on this phone${avail.reason ? ` (${avail.reason.replace(/\.$/, '')})` : ''}. Install or update it, then try again.`
          : 'Apple Health isn’t available on this device.');
        return;
      }
      const chosen = IMPORT_KINDS.filter(k => types.has(k.type));
      await store.authorize(chosen.map(k => k.type));
      const start = period === 'since_last' ? importStart(existing, store.source, today, 90) : daysBefore(today, Number(period));
      if (start >= today) {
        setBusy(null);
        setError('Everything up to yesterday is already imported. Today’s readings can be imported from tomorrow, once the day is complete.');
        return;
      }
      const rows: ParseResult['measurements'] = [];
      const empty: string[] = [];
      for (const kind of chosen) {
        setBusy(`Reading ${kind.label.toLowerCase()}…`);
        const readings = await store.read(kind.type, start, today);
        const found = onlyNewDays(toMeasurements(dailyValues(kind, readings, today), store.source), existing);
        if (found.length) rows.push(...found); else empty.push(kind.label);
      }
      setBusy(null);
      if (!rows.length) {
        setCanOpenSettings(!!store.openSettings);
        setError(`No new readings were found since ${start}. ${store.source === 'apple_health'
          ? 'If you didn’t allow LotusPond Health to read them, turn them on in Settings → Health → Data Access & Devices → LotusPond Health.'
          : 'If you didn’t allow LotusPond Health to read them, turn them on in Health Connect → App permissions → LotusPond Health.'}`);
        return;
      }
      const summary = importSummary(rows);
      onDraft({
        measurements: rows, scans: [], blobs: {}, detectedDate: null, warnings: [],
        notes: [`From ${name}, one average per day: ${summary}.${empty.length ? ` Nothing new for ${empty.join(', ').toLowerCase()}.` : ''} Today’s readings come in with the next import.`],
      });
    } catch (e) {
      setBusy(null);
      setCanOpenSettings(!!store.openSettings);
      setError(`${name} could not be read. ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const toggle = (t: HealthReadType) => setTypes(s => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });

  return (
    <div className="health-import" role="region" aria-label={`Import from ${name}`}>
      <p className="lede">Read measurements saved in {name} on this phone, such as blood pressure from a cuff, weight from a scale or glucose from a meter. You check them before anything is added. LotusPond only reads; it never changes {name}.</p>
      {other && <p className="warn">These are the readings saved on this phone. Import them only if they are {firstName(profile)}’s.</p>}
      <fieldset className="health-import__kinds">
        <legend>What to read</legend>
        {IMPORT_KINDS.map(k => (
          <label key={k.type} className="confirm-check">
            <input type="checkbox" checked={types.has(k.type)} onChange={() => toggle(k.type)} disabled={!!busy} />
            <span>{k.label}</span>
          </label>
        ))}
      </fieldset>
      <label className="health-import__period">From
        <select value={period} onChange={e => setPeriod(e.target.value as Period)} disabled={!!busy}>
          {imported && <option value="since_last">Since the last import</option>}
          {PERIODS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="tools dialog__actions">
        <button className="btn" onClick={onCancel} disabled={!!busy}>Back</button>
        {canOpenSettings && store.openSettings && <button className="btn" onClick={() => void store.openSettings!()} disabled={!!busy}>Open Health Connect</button>}
        <button className="btn btn--primary" onClick={() => void go()} disabled={!!busy || types.size === 0}>{busy ?? `Read from ${name}`}</button>
      </div>
    </div>
  );
}
