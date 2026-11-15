// Account, Connected agents and assistant: link a WhatsApp number to talk to the assistant there (shared/whatsapp.ts).
// Linking: agree to the notice, then send the code from WhatsApp to LotusPond's number (a link writes the message).
// The page checks every few seconds until the message has arrived.
import { useCallback, useEffect, useState } from 'react';
import { backend, errorMessage } from '../api';
import { useSession } from '../state/session';
import { useAssistant } from '../state/assistant';
import { toast } from '../state/toast';
import { linkMessage, type WhatsAppInfo, type WhatsAppLinkStart } from '../../shared/whatsapp';
import { ConfirmButton } from './forms';

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function WhatsAppSettings() {
  const profiles = useSession(s => s.profiles);
  const assistant = useAssistant(s => s.info);
  const loadAssistant = useAssistant(s => s.load);
  const [info, setInfo] = useState<WhatsAppInfo | null>(null);
  const [asking, setAsking] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [start, setStart] = useState<WhatsAppLinkStart | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const next = await backend.whatsappInfo(); setInfo(next); return next; } catch { return null; }
  }, []);
  useEffect(() => {
    let live = true;
    backend.whatsappInfo().then(next => { if (live) setInfo(next); }, () => {});
    return () => { live = false; };
  }, []);
  useEffect(() => { if (!assistant) void loadAssistant(); }, [assistant, loadAssistant]);

  // Waiting for the message from WhatsApp.
  useEffect(() => {
    if (!start) return;
    const t = setInterval(async () => {
      const next = await load();
      if (next?.link) { setStart(null); setAsking(false); toast.info('WhatsApp linked. Message LotusPond there any time.'); }
      else if (Date.parse(start.expiresAt) < Date.now()) { setStart(null); toast.error('The code expired. Get a new one.'); }
    }, 3000);
    return () => clearInterval(t);
  }, [start, load]);

  if (!info?.enabled) return null;
  const assistantOn = !!assistant?.consent?.granted && assistant.consent.version === assistant.noticeVersion;
  const link = info.link;
  const name = (id: string) => profiles.find(p => p.id === id)?.displayName ?? 'a profile';

  async function getCode() {
    setBusy(true);
    try { setStart(await backend.startWhatsAppLink()); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <div className="agents__assistant agents__whatsapp">
      <div>
        <b>WhatsApp</b>
        <small>{link
          ? `Linked to ${link.phone} · works on ${name(link.profileId)}’s records`
          : assistantOn ? 'Talk to the assistant and send reports from WhatsApp.' : 'Turn on the assistant (Ask, in the top bar) to use it on WhatsApp.'}</small>
      </div>
      {link && (
        <div className="agents__row-actions">
          {profiles.length > 1 && (
            <label className="agents__wa-profile">
              <span className="sr-only">Profile WhatsApp works on</span>
              <select value={link.profileId} onChange={async e => {
                try { const l = await backend.setWhatsAppProfile(e.target.value); setInfo(i => i && { ...i, link: l }); toast.info(`WhatsApp now works on ${name(l.profileId)}’s records.`); } catch (err) { toast.error(errorMessage(err)); }
              }}>
                {profiles.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
              </select>
            </label>
          )}
          <ConfirmButton confirmText="Unlink WhatsApp?" busyText="Unlinking…" className="btn btn--small btn--danger"
            onConfirm={async () => { try { await backend.unlinkWhatsApp(); await load(); toast.info('WhatsApp unlinked.'); } catch (e) { toast.error(errorMessage(e)); } }}>Unlink</ConfirmButton>
        </div>
      )}
      {!link && assistantOn && !asking && (
        <div className="agents__row-actions"><button type="button" className="btn btn--small btn--primary" onClick={() => setAsking(true)}>Link WhatsApp</button></div>
      )}
      {!link && asking && !start && (
        <div className="agents__form agents__edit wa-notice">
          <p>Before you link a number:</p>
          <ul>
            <li>Messages go through WhatsApp, run by Meta. Meta handles them under WhatsApp’s terms; LotusPond keeps the conversation in your account.</li>
            <li>The assistant answers with Claude (Anthropic), reading what you chose for it, and can add readings you tell it.</li>
            <li>Answers include health information. Anyone who can open WhatsApp on that phone can read them.</li>
            <li>Photos and PDFs you send are saved to your files for you to check in the app.</li>
            <li>Send STOP in WhatsApp, or unlink here, to end it.</li>
          </ul>
          <label className="confirm-check"><input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} /><span>I agree, and the number I will message from is mine.</span></label>
          <div className="panel__actions">
            <button type="button" className="btn btn--small" onClick={() => { setAsking(false); setAgreed(false); }} disabled={busy}>Cancel</button>
            <button type="button" className="btn btn--small btn--primary" disabled={!agreed || busy} onClick={() => void getCode()}>{busy ? 'Getting a code…' : 'Get a code'}</button>
          </div>
        </div>
      )}
      {!link && start && (
        <div className="agents__form agents__edit wa-code">
          <p>Send this message from your WhatsApp. It proves the number is yours.</p>
          <a className="btn btn--primary wa-open" href={start.url} target="_blank" rel="noopener noreferrer">Open WhatsApp</a>
          <p className="note">Or send <b>{linkMessage(start.code)}</b> to <b>{start.number}</b>. The code works until {time(start.expiresAt)}.</p>
          <p className="note wa-wait" role="status"><span className="dots" aria-hidden="true"><i /><i /><i /></span> Waiting for your message…</p>
          <div className="panel__actions"><button type="button" className="btn btn--small" onClick={() => { setStart(null); setAsking(false); }}>Cancel</button></div>
        </div>
      )}
    </div>
  );
}
