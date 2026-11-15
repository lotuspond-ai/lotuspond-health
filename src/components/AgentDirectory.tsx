// Account, Connected agents: how to connect each agent (shared/agent-directory.ts), and a summary to paste into
// assistants that cannot take a custom connector (Gemini app, Grok app, Meta AI, …).
import { useMemo, useState } from 'react';
import { backend, errorMessage } from '../api';
import { useSession } from '../state/session';
import { toast } from '../state/toast';
import { AGENT_CATEGORIES, AGENT_CATEGORY_TEXT, type AgentCategory } from '../../shared/agents';
import { AGENT_DIRECTORY, AGENT_GROUP_TEXT, fillAgentText, summaryForChat, type AgentDirectoryEntry } from '../../shared/agent-directory';
import { healthSummary } from '../../shared/synthesis';

const KIND_TEXT: Record<AgentDirectoryEntry['kind'], string> = {
  connector: 'Connector, signs in',
  config: 'Add the address',
  api: 'Access token',
  paste: 'Paste a summary',
};

function copy(text: string, what: string) {
  navigator.clipboard?.writeText(text).then(() => toast.info(`${what} copied.`), () => toast.error('Could not copy. Select the text and copy it.'));
}

export function AgentDirectory({ mcpUrl }: { mcpUrl: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(() => (Object.keys(AGENT_GROUP_TEXT) as AgentDirectoryEntry['group'][]).map(g => ({ g, items: AGENT_DIRECTORY.filter(a => a.group === g) })), []);
  const entry = AGENT_DIRECTORY.find(a => a.id === open) ?? null;
  return (
    <div className="agentdir">
      <h3>Connect an agent</h3>
      {groups.map(({ g, items }) => (
        <div key={g} className="agentdir__group">
          <small className="agentdir__label">{AGENT_GROUP_TEXT[g]}</small>
          <div className="agentdir__chips" role="group" aria-label={AGENT_GROUP_TEXT[g]}>
            {items.map(a => (
              <button key={a.id} type="button" className="agentdir__chip" aria-pressed={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
                <b>{a.name}</b><small>{KIND_TEXT[a.kind]}</small>
              </button>
            ))}
          </div>
        </div>
      ))}
      {entry && (
        <div className="agentdir__steps" role="region" aria-label={`Connect ${entry.name}`}>
          <b>{entry.name} <small>· {entry.maker}</small></b>
          <ol>{entry.steps.map((s, i) => <li key={i}>{fillAgentText(s, mcpUrl)}</li>)}</ol>
          {entry.snippet && (
            <>
              <pre className="agents__pre">{fillAgentText(entry.snippet, mcpUrl)}</pre>
              <button type="button" className="btn btn--small" onClick={() => copy(fillAgentText(entry.snippet!, mcpUrl), 'Configuration')}>Copy</button>
            </>
          )}
          {entry.token && <p className="note">Create the access token under the list of connections. It is shown once; paste it where the configuration says.</p>}
          {entry.note && <p className="note">{entry.note}</p>}
          {entry.kind === 'paste' && <p className="note">The summary is below.</p>}
        </div>
      )}
      <SummaryToPaste />
    </div>
  );
}

/** Copy one profile's summary as text: the same summary connected agents read, limited to the kinds chosen here. */
function SummaryToPaste() {
  const profiles = useSession(s => s.profiles);
  const activeId = useSession(s => s.activeId);
  const [profileId, setProfileId] = useState(activeId ?? profiles[0]?.id ?? '');
  const [kinds, setKinds] = useState<AgentCategory[]>(['results', 'conditions']);
  const [busy, setBusy] = useState(false);
  const shareable = AGENT_CATEGORIES.filter(k => k !== 'labs');
  async function make() {
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return;
    setBusy(true);
    try {
      const records = await backend.records(profile.id);
      copy(summaryForChat(healthSummary(profile, records, Date.now(), kinds)), 'Summary');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="agentdir__paste">
      <b>For assistants without connectors</b>
      <small>Copy a short summary and paste it into Gemini, Grok, Meta AI or any chat. It leaves LotusPond when you paste it, under that assistant’s terms.</small>
      <div className="agentdir__paste-row">
        <label><span className="sr-only">Whose summary</span>
          <select value={profileId} onChange={e => setProfileId(e.target.value)}>
            {profiles.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
        </label>
        {shareable.map(k => (
          <label key={k} className="agentdir__kind"><input type="checkbox" checked={kinds.includes(k)} onChange={() => setKinds(v => (v.includes(k) ? v.filter(x => x !== k) : [...v, k]))} /> {AGENT_CATEGORY_TEXT[k].title}</label>
        ))}
        <button type="button" className="btn btn--small btn--primary" disabled={busy || !profileId} onClick={() => void make()}>{busy ? 'Preparing…' : 'Copy summary'}</button>
      </div>
    </div>
  );
}
