// Home: what needs a look (the brief), where the records come from (Sources), which agents may use them (Agents),
// and lab results waiting. New accounts get three steps instead: add records, connect an agent, book a test.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { RecordConnectionView } from '../../shared/sources';
import type { AgentConnection } from '../../shared/agents';
import { backend, isPreview } from '../api';
import { useHealth } from '../lib/store';
import { buildSeries, formatDate } from '../lib/derive';
import { HomeBrief } from '../components/context/ContextPanel';
import { Icon } from '../components/ui';
import { useLab } from '../state/lab';
import { firstName, useActiveProfile, useSession } from '../state/session';
import { useUI, type View } from '../state/ui';

interface Status { connections: RecordConnectionView[] | null; agents: AgentConnection[] | null; agentServer: boolean }

/** Sources and agents for the cards; either can be missing (preview, agent off) without breaking Home. */
function useStatus(): Status {
  const [s, setS] = useState<Status>({ connections: null, agents: null, agentServer: !isPreview });
  useEffect(() => {
    let alive = true;
    backend.recordConnections().then(c => { if (alive) setS(v => ({ ...v, connections: c })); }, () => { if (alive) setS(v => ({ ...v, connections: [] })); });
    if (!isPreview) backend.agentConnections().then(r => { if (alive) setS(v => ({ ...v, agents: r.connections })); }, () => { if (alive) setS(v => ({ ...v, agents: [] })); });
    return () => { alive = false; };
  }, []);
  return s;
}

function Card({ title, icon, children, action }: { title: string; icon: ReactNode; children: ReactNode; action?: { label: string; view: View } }) {
  const setView = useUI(s => s.setView);
  return (
    <section className="panel home-card">
      <h2 className="home-card__title">{icon}<span>{title}</span></h2>
      <div className="home-card__body">{children}</div>
      {action && <button className="btn" onClick={() => setView(action.view)}>{action.label}</button>}
    </section>
  );
}

const latest = (dates: (string | null)[]) => dates.filter((d): d is string => !!d).sort().pop() ?? null;

export default function Home() {
  const measurements = useHealth(s => s.measurements);
  const series = useMemo(() => buildSeries(measurements), [measurements]);
  const profile = useActiveProfile();
  const profiles = useSession(s => s.profiles);
  const { setView, setUploadOpen } = useUI();
  const labResults = useLab(s => s.results.filter(r => r.status === 'pending').length);
  const { connections, agents, agentServer } = useStatus();

  const mine = connections?.filter(c => c.profileId === profile?.id) ?? [];
  const needSignIn = connections?.filter(c => c.status === 'needs_sign_in').length ?? 0;
  const lastCheck = latest(mine.map(c => c.lastSuccessAt?.slice(0, 10) ?? null));
  const sees = agents?.filter(a => profile && a.profileIds.includes(profile.id)) ?? [];
  const isNew = !series.length && connections !== null && !connections.length && (!agentServer || agents !== null) && !agents?.length;
  const name = profiles.length > 1 && profile ? `${firstName(profile)}’s records` : 'Your records';

  return (
    <main className="page home">
      {isNew ? (
        <>
          <div className="page__head"><div><h1>Welcome to LotusPond Health</h1><p>Your family’s health records in one place, ready for any AI agent you choose.</p></div></div>
          <ol className="home-steps">
            <li className="panel">
              <b>1. Bring in your records</b>
              <p>Connect a lab, hospital, ABHA or a device, and LotusPond fetches your reports. Or upload a PDF or a photo of one.</p>
              <div className="tools"><button className="btn btn--primary" onClick={() => setView('sources')}>Connect a source</button><button className="btn" onClick={() => setUploadOpen(true)}>{Icon.upload} Upload</button></div>
            </li>
            <li className="panel">
              <b>2. Use them with your AI</b>
              <p>Add LotusPond to Claude, ChatGPT or another agent. You choose whose records it sees.</p>
              <div className="tools"><button className="btn" onClick={() => setView('agents')}>Connect an agent</button></div>
            </li>
            <li className="panel">
              <b>3. Book a test at home</b>
              <p>A lab collects the sample at home, and the results come back into your records for you to check.</p>
              <div className="tools"><button className="btn" onClick={() => setView('labs')}>Find a lab</button></div>
            </li>
          </ol>
        </>
      ) : (
        <div className="home-grid">
          <section className="panel home-brief" aria-label={name}>
            {series.length ? <HomeBrief series={series} onHome /> : (
              <div className="brief">
                <h2 className="brief__head">No results yet</h2>
                <p className="brief__sub">Results appear here once a source brings in a report, or you upload one.</p>
                <div className="tools"><button className="btn btn--primary" onClick={() => setUploadOpen(true)}>{Icon.upload} Upload a report</button></div>
              </div>
            )}
          </section>
          <div className="home-side">
            <Card title="Sources" icon={Icon.file} action={{ label: mine.length ? 'Open Sources' : 'Connect a source', view: 'sources' }}>
              {connections === null ? <p className="note">Loading…</p>
                : mine.length ? <p><b>{mine.length}</b> connected{lastCheck ? `, last checked ${formatDate(lastCheck)}` : ''}.</p>
                : <p className="note">Nothing connected for this profile yet. Connect a lab, hospital, ABHA or a device to bring reports in.</p>}
              {needSignIn > 0 && <p className="home-card__warn">{needSignIn} need{needSignIn === 1 ? 's' : ''} you to sign in again.</p>}
            </Card>
            <Card title="Agents" icon={Icon.agent} action={agentServer ? { label: sees.length ? 'Open Agents' : 'Connect an agent', view: 'agents' } : undefined}>
              {!agentServer ? <p className="note">Agents connect to the LotusPond server; this preview has none.</p>
                : agents === null ? <p className="note">Loading…</p>
                : sees.length ? <p><b>{sees.length}</b> agent{sees.length === 1 ? '' : 's'} can see these records: {sees.slice(0, 3).map(a => a.name).join(', ')}{sees.length > 3 ? '…' : ''}.</p>
                : <p className="note">No agent can see these records. Add LotusPond to Claude, ChatGPT or another agent.</p>}
            </Card>
            <Card title="Labs" icon={Icon.pin} action={{ label: labResults ? 'Check results' : 'Find a lab', view: 'labs' }}>
              {labResults ? <p><b>{labResults}</b> lab result{labResults === 1 ? '' : 's'} waiting for you to check.</p>
                : <p className="note">Book a sample collection at home, or find a lab, imaging centre or hospital near you.</p>}
            </Card>
          </div>
        </div>
      )}
    </main>
  );
}
