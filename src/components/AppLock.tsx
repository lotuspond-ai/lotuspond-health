import { useState } from 'react';
import { appLock, useLock } from '../native/lock';
import { platform } from '../native/platform';
import { LOCK_DELAYS, type LockDelay } from '../lib/applock';
import { Logo } from './ui';

/** Full-screen cover while the app is locked (and while the lock is being checked at launch). */
export function LockScreen() {
  const status = useLock(s => s.status), message = useLock(s => s.message);
  const method = useLock(s => s.biometry?.method ?? 'Face ID');
  return (
    <div className="lock" role="dialog" aria-modal="true" aria-labelledby="lock-title">
      <div className="lock__card">
        <Logo />
        <h1 id="lock-title">LotusPond Health is locked</h1>
        <p>Your results stay hidden until you unlock.</p>
        {status !== 'starting' && (
          <button className="btn btn--primary" disabled={status === 'authenticating'} onClick={() => void appLock?.unlock()}>
            {status === 'authenticating' ? 'Unlocking…' : `Unlock with ${method}`}
          </button>
        )}
        {message && <p className="lock__msg" role="alert">{message}</p>}
      </div>
    </div>
  );
}

const DELAY_LABEL: Record<LockDelay, string> = { 0: 'as soon as you leave the app', 60_000: '1 minute after you leave', 300_000: '5 minutes after you leave' };

/** "App lock" section of the Your data page; only in the iOS / Android apps. */
export function AppLockSettings() {
  const settings = useLock(s => s.settings), biometry = useLock(s => s.biometry), message = useLock(s => s.message);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!appLock) return null;
  const lock = appLock;
  const method = biometry?.method ?? (platform === 'ios' ? 'Face ID' : 'fingerprint');
  const usable = !biometry || biometry.available || biometry.deviceSecure;
  const fallback = platform === 'ios' ? 'your passcode' : 'your screen lock';

  async function run(task: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await task(); } catch { setError('The setting could not be saved. Try again.'); } finally { setBusy(false); }
  }

  return (
    <div className="section">
      <h3>App lock</h3>
      <p className="lede">Ask for {method} when LotusPond opens, so someone holding your unlocked phone can't see your results. {method === 'passcode' || method === 'screen lock' ? '' : `If ${method} doesn't work, ${fallback} does.`}</p>
      <div className="tools" style={{ marginTop: 12 }}>
        <button className="toggle" aria-pressed={settings.enabled} disabled={busy || (!usable && !settings.enabled)}
          onClick={() => void run(() => lock.setEnabled(!settings.enabled))}><i />Require {method}</button>
        {settings.enabled && (
          <label className="note">Lock again{' '}
            <select className="inline-select" value={settings.delayMs} disabled={busy}
              onChange={e => void run(() => lock.setDelay(Number(e.target.value) as LockDelay))}>
              {LOCK_DELAYS.map(d => <option key={d} value={d}>{DELAY_LABEL[d]}</option>)}
            </select>
          </label>
        )}
      </div>
      {(error || message) && <p className="note" role="status" style={{ marginTop: 8 }}>{error ?? message}</p>}
      {!usable && <p className="note" style={{ marginTop: 8 }}>Set up Face ID, a fingerprint or a passcode in your phone's settings to use the app lock.</p>}
      <p className="note" style={{ marginTop: 8 }}>
        The lock hides LotusPond; your saved results are protected by your phone's own encryption, as before.
        {platform === 'android' ? ' While the lock is on, screenshots of the app are blocked.' : ''}
      </p>
    </div>
  );
}
