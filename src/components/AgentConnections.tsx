// Account, Connected agents: which AI agents can read these records, what they may do, and how to connect a new one.
// Agents that sign in with OAuth (Claude, ChatGPT and other MCP clients) only need the MCP address; others get an
// access token made here, shown once.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { backend, errorMessage } from '../api';
import { useSession } from '../state/session';
import { toast } from '../state/toast';
import {
  AGENT_BASICS_TEXT, AGENT_CATEGORIES, AGENT_CATEGORY_TEXT, AGENT_EXPIRY_CHOICES, AGENT_SCOPE_TEXT, AGENT_SCOPES,
  type AgentCategory, type AgentConnection, type AgentScope, type CreatedAgentToken,
} from '../../shared/agents';
import { ConfirmButton, Field } from './forms';
import { useAssistant } from '../state/assistant';
import { WhatsAppSettings } from './WhatsAppSettings';
import { AgentDirectory } from './AgentDirectory';
import '../styles/agents.css';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never');

function copy(text: string, what: string) {
  navigator.clipboard?.writeText(text).then(() => toast.info(`${what} copied.`), () => toast.error('Could not copy. Select the text and copy it.'));
}

export function AgentConnectionsPanel() {
  const profiles = useSession(s => s.profiles);
  const [mcpUrl, setMcpUrl] = useState<string | null>(null);
  const [list, setList] = useState<AgentConnection[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [made, setMade] = useState<CreatedAgentToken | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const reload = useCallback(() => {
    backend.agentConnections().then(r => { setMcpUrl(r.mcpUrl); setList(r.connections); setFailed(false); }, () => setFailed(true));
  }, []);
  useEffect(reload, [reload]);
  const names = (ids: string[]) => ids.map(id => profiles.find(p => p.id === id)?.displayName).filter(Boolean).join(', ') || 'No profiles';

  return (
    <section className="panel" aria-labelledby="agents-h">
      <h2 id="agents-h">Connected agents</h2>
      <p className="note panel__intro">
        Let AI agents such as Claude, ChatGPT, Gemini, Grok or Meta AI read your health records and help with them. You choose whose
        records each agent sees and whether it may add to them. Disconnect at any time: it stops at once.
      </p>
      <AssistantSettings />
      <WhatsAppSettings />
      {failed && <p className="form-error" role="alert">Connected agents could not be loaded.</p>}
      {mcpUrl && (
        <div className="agents__url">
          <span className="note">Address to give an agent (MCP server, remote connector)</span>
          <div className="agents__copy">
            <code>{mcpUrl}</code>
            <button type="button" className="btn btn--small" onClick={() => copy(mcpUrl, 'Address')}>Copy</button>
          </div>
        </div>
      )}
      {mcpUrl && <AgentDirectory mcpUrl={mcpUrl} />}
      <p className="note">An agent’s company receives what it reads, under its own privacy terms. Share only the profiles it needs.</p>

      {list && list.length === 0 && <p className="note">No agents connected yet.</p>}
      {list && list.length > 0 && (
        <ul className="agents__list">
          {list.map(a => (
            <li key={a.id}>
              <div>
                <b>{a.name}</b>
                <small>
                  {a.kind === 'oauth' ? `Signed in${a.redirectHost ? ` via ${a.redirectHost}` : ''}` : 'Access token'}
                  {' · '}{a.scopes.map(s => AGENT_SCOPE_TEXT[s].title).join(', ')}
                </small>
                <small>Sees: {names(a.profileIds)} · {a.categories.length ? a.categories.map(k => AGENT_CATEGORY_TEXT[k].title).join(', ') : 'the basics only'}</small>
                <small>Last used: {when(a.lastUsedAt)} · {a.expiresAt ? `Expires ${when(a.expiresAt)}` : 'No expiry'}</small>
                {editing === a.id && <EditConnection conn={a} onDone={changed => { setEditing(null); if (changed) reload(); }} />}
              </div>
              <div className="agents__row-actions">
              {editing !== a.id && <button type="button" className="btn btn--small" onClick={() => setEditing(a.id)}>Change</button>}
              <ConfirmButton confirmText={`Disconnect ${a.name}?`} busyText="Disconnecting…" className="btn btn--small btn--danger"
                onConfirm={async () => {
                  try { await backend.disconnectAgent(a.id); toast.info(`${a.name} disconnected.`); reload(); } catch (e) { toast.error(errorMessage(e)); }
                }}>Disconnect</ConfirmButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      {made ? <TokenShown made={made} onDone={() => setMade(null)} /> : <CreateToken onCreated={m => { setMade(m); reload(); }} />}
    </section>
  );
}

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);

interface Choice { profileIds: string[]; categories: AgentCategory[]; scopes: AgentScope[]; expires: string }

/** Whose records, which kinds of data, what it may do and how long: shared by the new token form and Change. */
function Choices({ value, onChange, expiryLabel }: { value: Choice; onChange: (c: Choice) => void; expiryLabel: string }) {
  const profiles = useSession(s => s.profiles);
  const set = (p: Partial<Choice>) => onChange({ ...value, ...p });
  return (
    <>
      <fieldset className="agents__choices">
        <legend>Whose records it may see</legend>
        {profiles.map(p => (
          <label key={p.id}><input type="checkbox" checked={value.profileIds.includes(p.id)} onChange={() => set({ profileIds: toggle(value.profileIds, p.id) })} /> {p.displayName}{p.relationship === 'self' ? ' (you)' : ''}</label>
        ))}
      </fieldset>
      <fieldset className="agents__choices">
        <legend>What it may see</legend>
        <small>{AGENT_BASICS_TEXT}</small>
        {AGENT_CATEGORIES.map(k => (
          <label key={k}>
            <input type="checkbox" checked={value.categories.includes(k)} onChange={() => set({ categories: toggle(value.categories, k) })} />
            <span>{AGENT_CATEGORY_TEXT[k].title}<small>{AGENT_CATEGORY_TEXT[k].detail}</small></span>
          </label>
        ))}
      </fieldset>
      <fieldset className="agents__choices">
        <legend>What it may do</legend>
        {AGENT_SCOPES.map(s => (
          <label key={s}>
            <input type="checkbox" checked={value.scopes.includes(s)} disabled={s === 'health:read'} onChange={() => set({ scopes: toggle(value.scopes, s) })} />
            <span>{AGENT_SCOPE_TEXT[s].title}<small>{AGENT_SCOPE_TEXT[s].detail}</small></span>
          </label>
        ))}
      </fieldset>
      <div className="form-grid">
        <Field label={expiryLabel}>{id => (
          <select id={id} value={value.expires} onChange={e => set({ expires: e.target.value })}>
            {value.expires === 'keep' && <option value="keep">Keep the current expiry</option>}
            <option value="7">7 days</option>
            {AGENT_EXPIRY_CHOICES.map(x => <option key={x.days ?? 'never'} value={x.days ?? 'never'}>{x.label}</option>)}
          </select>
        )}</Field>
      </div>
    </>
  );
}

const expiryDays = (v: string): number | null => (v === 'never' ? null : Number(v));

function CreateToken({ onCreated }: { onCreated: (m: CreatedAgentToken) => void }) {
  const profiles = useSession(s => s.profiles);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [choice, setChoice] = useState<Choice>(() => ({
    profileIds: profiles.filter(p => p.relationship === 'self').map(p => p.id), categories: [...AGENT_CATEGORIES], scopes: ['health:read'], expires: '90',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return <div className="panel__actions"><button type="button" className="btn" onClick={() => setOpen(true)}>Create an access token</button></div>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Name the agent, so you can tell connections apart.'); return; }
    if (!choice.profileIds.length) { setError('Choose at least one profile.'); return; }
    setBusy(true);
    try {
      onCreated(await backend.createAgentToken({
        name: name.trim(), profileIds: choice.profileIds, scopes: choice.scopes, categories: choice.categories, expiresInDays: expiryDays(choice.expires),
      }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="agents__form" onSubmit={submit} noValidate>
      <h3>New access token</h3>
      <div className="form-grid">
        <Field label="Agent name" hint="For example: Claude Desktop, my health bot." wide>{id => <input id={id} value={name} maxLength={60} onChange={e => setName(e.target.value)} />}</Field>
      </div>
      <Choices value={choice} onChange={setChoice} expiryLabel="Expires after" />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="panel__actions">
        <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn btn--primary" disabled={busy}>{busy ? 'Creating…' : 'Create token'}</button>
      </div>
    </form>
  );
}

/** Change what a connection may see and do, and how long it lasts. It applies to the agent's next request. */
function EditConnection({ conn, onDone }: { conn: AgentConnection; onDone: (changed: boolean) => void }) {
  const [choice, setChoice] = useState<Choice>({ profileIds: conn.profileIds, categories: conn.categories, scopes: conn.scopes, expires: 'keep' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!choice.profileIds.length) { setError('Choose at least one profile, or disconnect the agent instead.'); return; }
    setBusy(true);
    setError(null);
    try {
      await backend.updateAgentConnection(conn.id, {
        profileIds: choice.profileIds, categories: choice.categories, scopes: choice.scopes,
        ...(choice.expires === 'keep' ? {} : { expiresInDays: expiryDays(choice.expires) }),
      });
      toast.info(`${conn.name} updated. It applies to its next request.`);
      onDone(true);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <form className="agents__form agents__edit" onSubmit={submit} noValidate aria-label={`Change ${conn.name}`}>
      <Choices value={choice} onChange={setChoice} expiryLabel="Connected for" />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="panel__actions">
        <button type="button" className="btn" onClick={() => onDone(false)} disabled={busy}>Cancel</button>
        <button className="btn btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

function TokenShown({ made, onDone }: { made: CreatedAgentToken; onDone: () => void }) {
  const config = JSON.stringify({ mcpServers: { 'lotuspond-health': { type: 'http', url: made.mcpUrl, headers: { Authorization: `Bearer ${made.token}` } } } }, null, 2);
  return (
    <div className="agents__made" role="status">
      <h3>Token for {made.connection.name}</h3>
      <p className="note">Copy it now: it is shown only once. Anyone with it can read the profiles you chose, so keep it like a password.</p>
      <div className="agents__copy"><code>{made.token}</code><button type="button" className="btn btn--small" onClick={() => copy(made.token, 'Token')}>Copy</button></div>
      <p className="note">For MCP clients configured with JSON (Claude Desktop, Claude Code, Cursor):</p>
      <pre className="agents__pre">{config}</pre>
      <div className="panel__actions">
        <button type="button" className="btn" onClick={() => copy(config, 'Configuration')}>Copy configuration</button>
        <button type="button" className="btn btn--primary" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

/** LotusPond's own assistant: what it may read, and turning it off (the consent is recorded each time). */
function AssistantSettings() {
  const { info, load, agree } = useAssistant();
  const [editing, setEditing] = useState(false);
  const [kinds, setKinds] = useState<AgentCategory[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!info) void load(); }, [info, load]);
  if (!info?.enabled) return null;
  const c = info.consent;
  const on = !!c?.granted;
  return (
    <div className="agents__assistant">
      <div>
        <b>LotusPond assistant</b>
        <small>{on
          ? `On · reads ${c!.categories.length ? c!.categories.map(k => AGENT_CATEGORY_TEXT[k].title.toLowerCase()).join(', ') : 'the basics only'} · runs on Claude by Anthropic`
          : 'Off. Turn it on from Ask in the top bar.'}</small>
      </div>
      {on && !editing && (
        <div className="agents__row-actions">
          <button type="button" className="btn btn--small" onClick={() => { setKinds(c!.categories); setEditing(true); }}>Change</button>
          <ConfirmButton confirmText="Turn off the assistant?" busyText="Turning off…" className="btn btn--small btn--danger"
            onConfirm={async () => { try { await backend.withdrawAssistant(); await load(); toast.info('The assistant is off.'); } catch (e) { toast.error(errorMessage(e)); } }}>Turn off</ConfirmButton>
        </div>
      )}
      {editing && (
        <div className="agents__form agents__edit">
          <fieldset className="agents__choices">
            <legend>What it may read</legend>
            {AGENT_CATEGORIES.map(k => (
              <label key={k}><input type="checkbox" checked={kinds.includes(k)} onChange={() => setKinds(v => (v.includes(k) ? v.filter(x => x !== k) : [...v, k]))} />
                <span>{AGENT_CATEGORY_TEXT[k].title}</span></label>
            ))}
          </fieldset>
          <div className="panel__actions">
            <button type="button" className="btn btn--small" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
            <button type="button" className="btn btn--small btn--primary" disabled={busy} onClick={async () => {
              setBusy(true);
              try { await agree(kinds); setEditing(false); toast.info('Saved. It applies to your next message.'); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
            }}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}
