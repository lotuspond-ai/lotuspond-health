// Chat with LotusPond's assistant (src/state/assistant.ts, shared/assistant.ts). A panel at the side on wide screens
// and full screen on phones. The first time, a notice explains that answers come from Claude, run by Anthropic, and
// lets the person choose the kinds of data it may read. Voice: speak instead of typing where the browser offers
// speech recognition, and have answers read aloud.
import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AGENT_BASICS_TEXT, AGENT_CATEGORIES, AGENT_CATEGORY_TEXT, type AgentCategory } from '../../../shared/agents';
import { ASSISTANT_MAX_INPUT, ASSISTANT_NOTICE_VERSION } from '../../../shared/assistant';
import { countryName } from '../../../shared/regions';
import { backend, errorMessage, isPreview } from '../../api';
import { useAssistant } from '../../state/assistant';
import { firstName, useActiveProfile, useSession } from '../../state/session';
import { useEscape } from '../useEscape';
import { Icon } from '../ui';
import { ORGAN_BY_ID } from '../../anatomy/organs';
import { useHealth } from '../../lib/store';
import { useUI } from '../../state/ui';
import type { OrganId } from '../../types';
import '../../styles/assistant.css';

/* ---------------- text: paragraphs, bullet lists and **bold**, built as elements (never as HTML) ---------------- */

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : <Fragment key={i}>{part}</Fragment>));
}

export function RichText({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        if (lines.every(l => /^\s*[-*•]\s+/.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>)}</ul>;
        return <p key={i}>{lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>)}</p>;
      })}
    </>
  );
}

/* ---------------- voice ---------------- */

interface Recognition {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null; onerror: (() => void) | null;
  start(): void; stop(): void;
}
type RecognitionCtor = new () => Recognition;
const SpeechCtor = (typeof window !== 'undefined'
  ? (window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }).SpeechRecognition
    ?? (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition
  : undefined);
const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

function speak(text: string) {
  if (!canSpeak) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/\*\*/g, ''));
  u.lang = navigator.language || 'en-IN';
  window.speechSynthesis.speak(u);
}

/* ---------------- the panel ---------------- */

export function AssistantPanel() {
  const open = useAssistant(s => s.open);
  return open ? <Panel /> : null;
}

const SUGGESTIONS = ['What needs my attention?', 'How has my cholesterol changed?', 'My blood pressure today was 130/85', 'Which tests are due?'];

function Panel() {
  const { info, messages, live, error, setOpen, send, stop, newChat, openConversation, channel } = useAssistant();
  const setView = useUI(s => s.setView);
  // Offer WhatsApp when the server has it and this account has not linked a number.
  const [offerWhatsApp, setOfferWhatsApp] = useState(false);
  useEffect(() => {
    if (isPreview) return;
    let live = true;
    backend.whatsappInfo().then(w => { if (live) setOfferWhatsApp(w.enabled && !w.link); }, () => {});
    return () => { live = false; };
  }, []);
  const profile = useActiveProfile();
  // A question typed in the home brief before agreeing waits here.
  const [text, setText] = useState(() => { const d = useAssistant.getState().draft; useAssistant.setState({ draft: '' }); return d; });
  const [listening, setListening] = useState(false);
  const [readAloud, setReadAloud] = useState(false);
  const recog = useRef<Recognition | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const spoken = useRef(messages.length);
  const close = () => { recog.current?.stop(); setOpen(false); };
  useEscape(close);

  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }); }, [messages, live?.text, live?.doing]);
  useEffect(() => { input.current?.focus(); }, [info?.consent?.granted]);
  // Read each new answer aloud when that is on.
  useEffect(() => {
    if (messages.length > spoken.current) {
      const last = messages[messages.length - 1];
      if (readAloud && last.role === 'assistant') speak(last.text);
    }
    spoken.current = messages.length;
  }, [messages, readAloud]);
  useEffect(() => () => { if (canSpeak) window.speechSynthesis.cancel(); }, []);

  const agreed = !!info?.consent?.granted && info.consent.version === ASSISTANT_NOTICE_VERSION;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || !profile || live) return;
    setText('');
    void send(profile.id, t);
  };
  const listen = () => {
    if (!SpeechCtor) return;
    if (listening) { recog.current?.stop(); return; }
    const r = new SpeechCtor();
    r.lang = navigator.language || 'en-IN';
    r.interimResults = true;
    r.continuous = false;
    const base = text ? `${text.trim()} ` : '';
    r.onresult = ev => setText(base + Array.from(ev.results).map(x => x[0].transcript).join(''));
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recog.current = r;
    setListening(true);
    r.start();
  };

  const convs = info?.conversations.filter(c => c.profileId === profile?.id).slice(0, 6) ?? [];
  return (
    <aside className="assistant" role="dialog" aria-modal="false" aria-labelledby="assistant-title">
      <header className="assistant__head">
        <div>
          <h2 id="assistant-title">Ask LotusPond</h2>
          <p>{profile ? (profile.relationship === 'self' ? 'About your records' : `About ${firstName(profile)}’s records`) : ''}</p>
        </div>
        <div className="assistant__tools">
          {canSpeak && agreed && <button type="button" className={`btn btn--quiet btn--small${readAloud ? ' is-on' : ''}`} aria-pressed={readAloud} onClick={() => setReadAloud(v => !v)} title="Read answers aloud">{speakerIcon} <span className="sr-only">Read answers aloud</span></button>}
          {agreed && <button type="button" className="btn btn--quiet btn--small" onClick={newChat} disabled={!messages.length && !live}>New chat</button>}
          <button type="button" className="btn btn--quiet x" onClick={close} aria-label="Close">{Icon.close}</button>
        </div>
      </header>

      {!info ? <p className="note assistant__pad">Loading…</p>
        : isPreview || !info.enabled ? <p className="note assistant__pad">The assistant isn’t switched on for this server yet. It needs an Anthropic API key on the LotusPond server.</p>
        : !agreed ? <Consent />
        : (
          <>
            <div className="assistant__list" ref={list} aria-live="polite">
              {!messages.length && !live && (
                <div className="assistant__empty">
                  <p className="lede">Ask about results, tell me a reading to add, or ask me to find a lab test. I’ll show what I mean on the body.</p>
                  <div className="assistant__chips">{SUGGESTIONS.map(s => <button key={s} type="button" className="chip-btn" onClick={() => { if (profile) void send(profile.id, s); }}>{s}</button>)}</div>
                  {convs.length > 0 && (
                    <div className="assistant__recent"><h3>Recent</h3>
                      {convs.map(c => <button key={c.id} type="button" className="linkish" onClick={() => void openConversation(c.id)}>{c.channel === 'whatsapp' ? `WhatsApp · ${c.title}` : c.title}</button>)}
                    </div>
                  )}
                  {offerWhatsApp && (
                    <p className="note assistant__wa">Talk to LotusPond on WhatsApp too, and send reports from there. <button type="button" className="linkish" onClick={() => { close(); setView('account'); }}>Link WhatsApp</button></p>
                  )}
                </div>
              )}
              {messages.map(m => <Bubble key={m.id} role={m.role} text={m.text} tools={m.tools} organs={m.organs} links={m.links} wrote={m.wrote} />)}
              {live && (
                <Bubble role="assistant" text={live.text} tools={live.tools} organs={live.organs} links={live.links} doing={live.doing} wrote={live.wrote} />
              )}
              {error && <p className="form-error assistant__error" role="alert">{error}</p>}
            </div>
            {channel === 'whatsapp' ? (
              <div className="assistant__composer assistant__composer--note">
                <p className="note">This conversation happened on WhatsApp. Carry it on there, or start a new chat here.</p>
                <button type="button" className="btn btn--primary btn--small" onClick={newChat}>New chat</button>
              </div>
            ) : (
            <form className="assistant__composer" onSubmit={submit}>
              <textarea ref={input} value={text} rows={1} maxLength={ASSISTANT_MAX_INPUT} placeholder={listening ? 'Listening…' : 'Message LotusPond'}
                aria-label="Message LotusPond" onChange={e => setText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} />
              {SpeechCtor && <button type="button" className={`assistant__mic${listening ? ' is-on' : ''}`} onClick={listen} aria-pressed={listening}
                title="Speak instead of typing. Your browser turns speech into text; in Chrome, Google processes the audio." aria-label={listening ? 'Stop listening' : 'Speak'}>{micIcon}</button>}
              {live
                ? <button type="button" className="btn btn--small" onClick={stop}>Stop</button>
                : <button className="btn btn--primary btn--small" disabled={!text.trim()}>Send</button>}
            </form>
            )}
            <p className="assistant__foot">Answers come from Claude and can be wrong. LotusPond explains results; it does not diagnose. In an emergency, call your local emergency number.</p>
          </>
        )}
    </aside>
  );
}

function Bubble({ role, text, tools, organs, links, doing, wrote }: { role: 'user' | 'assistant'; text: string; tools?: string[]; organs?: string[]; links?: { label: string; url: string }[]; doing?: string | null; wrote?: boolean }) {
  if (role === 'user') return <div className="bubble bubble--me"><p>{text}</p></div>;
  const shown = [...new Set(organs ?? [])].filter((o): o is OrganId => o in ORGAN_BY_ID);
  return (
    <div className="bubble bubble--ai">
      {text ? <RichText text={text} /> : null}
      {doing && <p className="bubble__doing"><span className="dots" aria-hidden><i /><i /><i /></span>{doing}</p>}
      {(shown.length > 0 || (tools?.length ?? 0) > 0 || wrote) && (
        <p className="bubble__meta">
          {shown.map(o => <button key={o} type="button" className="bubble__organ" onClick={() => showOrganNow(o)}>Show {ORGAN_BY_ID[o].short.toLowerCase()}</button>)}
          {wrote && <span>Added to your records</span>}
          {tools?.length ? <span>Looked at {[...new Set(tools)].join(', ').toLowerCase()}</span> : null}
        </p>
      )}
      {links?.map(l => <a key={l.url} className="btn btn--primary btn--small bubble__link" href={localLink(l.url)}>{l.label}</a>)}
    </div>
  );
}

/** A link the assistant proposes points into the app; keep it on this host (the apps use their own). */
function localLink(url: string): string {
  try { const u = new URL(url, window.location.href); return `${u.pathname.endsWith('/app') ? window.location.pathname : u.pathname}${u.search}${u.hash}`; } catch { return url; }
}

function showOrganNow(o: OrganId) {
  useUI.getState().setView('body');
  useHealth.getState().selectOrgan(o);
}

/* ---------------- first time: what happens to the data ---------------- */

function Consent() {
  const agree = useAssistant(s => s.agree);
  const country = useSession(s => s.account?.country);
  const [kinds, setKinds] = useState<AgentCategory[]>([...AGENT_CATEGORIES]);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (k: AgentCategory) => setKinds(v => (v.includes(k) ? v.filter(x => x !== k) : [...v, k]));
  return (
    <div className="assistant__pad assistant__consent">
      <h3>Before you start</h3>
      <p>The assistant answers with Claude, an AI made by Anthropic. To answer, it reads the parts of your records it needs and sends them to Anthropic with your message. They may be processed outside {country ? countryName(country) : 'your country'}, under Anthropic’s terms. Conversations are kept in your account until you delete them.</p>
      <fieldset className="agents__choices">
        <legend>What it may read</legend>
        <small>{AGENT_BASICS_TEXT.replace('Every connection sees', 'It always sees')}</small>
        {AGENT_CATEGORIES.map(k => (
          <label key={k}><input type="checkbox" checked={kinds.includes(k)} onChange={() => toggle(k)} />
            <span>{AGENT_CATEGORY_TEXT[k].title}<small>{AGENT_CATEGORY_TEXT[k].detail}</small></span></label>
        ))}
      </fieldset>
      <p className="note">It can add a reading or a condition, medication or allergy when you tell it to, and you can undo each from the bell. It never books or pays for anything: it prepares a booking for you to confirm.</p>
      <label className="confirm-check"><input type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} />
        <span>I agree to send what the assistant needs to Anthropic to answer me. I can withdraw this on Account.</span></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="panel__actions">
        <button type="button" className="btn btn--primary" disabled={!ok || busy} onClick={async () => {
          setBusy(true); setError(null);
          try { await agree(kinds); } catch (e) { setError(errorMessage(e)); setBusy(false); }
        }}>{busy ? 'Saving…' : 'Start'}</button>
      </div>
    </div>
  );
}

const micIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);
const speakerIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 10v4h4l5 4V6L8 10z" /><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
  </svg>
);

/** The "Ask LotusPond" button for the top bar. */
export function AskButton() {
  const setOpen = useAssistant(s => s.setOpen);
  const signedIn = useSession(s => s.status === 'signed-in');
  if (!signedIn || isPreview) return null;
  return (
    <button className="btn assistant__ask" onClick={() => setOpen(true)} aria-label="Ask LotusPond">
      {sparkIcon}<span>Ask</span>
    </button>
  );
}

/** The ask box at the end of the home brief: typing there opens the chat with that message. */
export function AskBox() {
  const { setOpen, send, info, load } = useAssistant();
  const profile = useActiveProfile();
  const [text, setText] = useState('');
  useEffect(() => { if (!info) void load(); }, [info, load]);
  if (isPreview || (info && !info.enabled)) return null;
  const agreed = !!info?.consent?.granted && info.consent.version === ASSISTANT_NOTICE_VERSION;
  return (
    <form className="askbox" onSubmit={e => {
      e.preventDefault();
      setOpen(true);
      const t = text.trim();
      if (!t) return;
      setText('');
      if (profile && agreed) void send(profile.id, t);
      else useAssistant.setState({ draft: t });
    }}>
      {sparkIcon}
      <input value={text} onChange={e => setText(e.target.value)} placeholder="Ask about your results, or tell me a reading" aria-label="Ask LotusPond" maxLength={ASSISTANT_MAX_INPUT} />
      <button className="btn btn--primary btn--small">Ask</button>
    </form>
  );
}

const sparkIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3l1.8 4.9L19 9.7l-4.6 2.6L13 18l-1-5.2L7 11l5-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
  </svg>
);
