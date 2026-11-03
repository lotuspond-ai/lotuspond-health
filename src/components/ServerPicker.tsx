// Test builds of the iOS and Android apps only (VITE_SERVER_PICKER=1, as CI builds the debug APK): choose which
// LotusPond server the app signs in to, so one build works with the public site or with a server on your
// computer (HOST=0.0.0.0 npm run local). Shown on the sign-in and "can't be reached" screens; release builds
// leave it out.
import { useState, type FormEvent } from 'react';
import { appApiOrigin, checkServer, chooseServer, currentServer, serverPicker } from '../api';
import { serverOrigin } from '../api/appSession';

const hostOf = (origin: string) => origin.replace(/^https?:\/\//, '');

export function ServerPicker() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(currentServer);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!serverPicker) return null;
  const current = currentServer();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const origin = serverOrigin(value);
    if (!origin) { setError('Enter an address such as http://192.168.1.20:8787 or https://health.lotuspond.ai.'); return; }
    setChecking(true);
    setError(null);
    try {
      await checkServer(origin);
    } catch {
      setChecking(false);
      setError(`No LotusPond server answered at ${origin}. Check the address and that the phone is on the same network. On your computer, start the server with HOST=0.0.0.0 npm run local.`);
      return;
    }
    await chooseServer(origin);
  };

  if (!open) {
    return (
      <p className="server-pick">
        Test build · server <b>{hostOf(current)}</b>{' '}
        <button type="button" className="linkish" onClick={() => setOpen(true)}>Change</button>
      </p>
    );
  }
  return (
    <form className="server-pick server-pick--open" onSubmit={e => void submit(e)} noValidate>
      <label htmlFor="server-url">LotusPond server (test builds only)</label>
      <input id="server-url" type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        placeholder="http://192.168.1.20:8787" value={value} onChange={e => { setValue(e.target.value); setError(null); }} />
      <p className="field__hint">Switching signs you out of the current server and restarts the app.</p>
      {error && <p className="field__error" role="alert">{error}</p>}
      <div className="server-pick__actions">
        <button className="btn btn--primary" disabled={checking}>{checking ? 'Checking…' : 'Use this server'}</button>
        {current !== appApiOrigin && <button type="button" className="btn" disabled={checking} onClick={() => void chooseServer(null)}>Back to {hostOf(appApiOrigin)}</button>}
        <button type="button" className="btn btn--quiet" disabled={checking} onClick={() => { setOpen(false); setValue(current); setError(null); }}>Cancel</button>
      </div>
    </form>
  );
}
