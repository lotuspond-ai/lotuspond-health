// Account, Connected agents: which AI agents can read these records, what they may do, and how to connect a new one.
// Agents that sign in with OAuth (Claude, ChatGPT and other MCP clients) only need the MCP address; others get an
// access token made here, shown once.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { backend, errorMessage } from '../api';
import { useSession } from '../state/session';
import { toast } from '../state/toast';
import { AGENT_SCOPE_TEXT, AGENT_SCOPES, type AgentConnection, type AgentScope, type CreatedAgentToken } from '../../shared/agents';
import { ConfirmButton, Field } from './forms';
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
      <details className="agents__how">
        <summary>How to connect</summary>
        <ul>
          <li><b>Claude</b> (claude.ai, desktop and mobile): Settings, Connectors, Add custom connector, paste the address. You sign in here and choose profiles.</li>
          <li><b>ChatGPT</b>: Settings, Apps and connectors, Create (developer mode), paste the address, OAuth. Availability depends on your ChatGPT plan.</li>
          <li><b>Claude Code, Cursor, VS Code and other MCP clients</b>: add a remote (HTTP) MCP server with the address; it opens this sign-in.</li>
          <li><b>Agents that take a token</b> (scripts, self-hosted agents, older clients): create an access token below and send it as <code>Authorization: Bearer</code>.</li>
        </ul>
        <p className="note">An agent's company receives what it reads, under its own privacy terms. Share only the profiles it needs.</p>
      </details>

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
                <small>Sees: {names(a.profileIds)}</small>
                <small>Last used: {when(a.lastUsedAt)}{a.expiresAt ? ` · Expires ${when(a.expiresAt)}` : ''}</small>
              </div>
              <ConfirmButton confirmText={`Disconnect ${a.name}?`} busyText="Disconnecting…" className="btn btn--small btn--danger"
                onConfirm={async () => {
                  try { await backend.disconnectAgent(a.id); toast.info(`${a.name} disconnected.`); reload(); } catch (e) { toast.error(errorMessage(e)); }
                }}>Disconnect</ConfirmButton>
            </li>
          ))}
        </ul>
      )}

      {made ? <TokenShown made={made} onDone={() => setMade(null)} /> : <CreateToken onCreated={m => { setMade(m); reload(); }} />}
    </section>
  );
}

function CreateToken({ onCreated }: { onCreated: (m: CreatedAgentToken) => void }) {
  const profiles = useSession(s => s.profiles);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>(() => profiles.filter(p => p.relationship === 'self').map(p => p.id));
  const [scopes, setScopes] = useState<AgentScope[]>(['health:read']);
  const [days, setDays] = useState<string>('90');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return <div className="panel__actions"><button type="button" className="btn" onClick={() => setOpen(true)}>Create an access token</button></div>;

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Name the agent, so you can tell connections apart.'); return; }
    if (!chosen.length) { setError('Choose at least one profile.'); return; }
    setBusy(true);
    try {
      onCreated(await backend.createAgentToken({ name: name.trim(), profileIds: chosen, scopes, expiresInDays: days === 'never' ? null : Number(days) }));
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
      <fieldset className="agents__choices">
        <legend>Whose records it may see</legend>
        {profiles.map(p => (
          <label key={p.id}><input type="checkbox" checked={chosen.includes(p.id)} onChange={() => setChosen(toggle(chosen, p.id))} /> {p.displayName}{p.relationship === 'self' ? ' (you)' : ''}</label>
        ))}
      </fieldset>
      <fieldset className="agents__choices">
        <legend>What it may do</legend>
        {AGENT_SCOPES.map(s => (
          <label key={s}>
            <input type="checkbox" checked={scopes.includes(s)} disabled={s === 'health:read'} onChange={() => setScopes(toggle(scopes, s))} />
            <span>{AGENT_SCOPE_TEXT[s].title}<small>{AGENT_SCOPE_TEXT[s].detail}</small></span>
          </label>
        ))}
      </fieldset>
      <div className="form-grid">
        <Field label="Expires">{id => (
          <select id={id} value={days} onChange={e => setDays(e.target.value)}>
            <option value="7">In 7 days</option><option value="30">In 30 days</option><option value="90">In 90 days</option>
            <option value="365">In a year</option><option value="never">Never</option>
          </select>
        )}</Field>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="panel__actions">
        <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn btn--primary" disabled={busy}>{busy ? 'Creating…' : 'Create token'}</button>
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
