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

/** One row of the setup summary: what it is, where it stands in words, and the way to it. */
function Row({ title, icon, status, children, action }: { title: string; icon: ReactNode; status: { label: string; ok: boolean } | null; children: ReactNode; action?: { label: string; view: View } }) {
  const setView = useUI(s => s.setView);
  return (
    <li className="home-row">
      <span className="home-row__icon" aria-hidden="true">{icon}</span>
      <div className="home-row__text">
        <h3>{title}{status && <span className={`home-status${status.ok ? ' is-ok' : ''}`}>{status.label}</span>}</h3>
        {children}
      </div>
      {action && <button className="btn btn--small" onClick={() => setView(action.view)}>{action.label}</button>}
    </li>
  );
}

/** The one dark chapter of Home: the same sign-in opens the developer console for healthcare organisations. */
function ForOrganisations() {
  const setView = useUI(s => s.setView);
  return (
    <section className="home-deep" aria-labelledby="home-deep-h">
      <p className="home-deep__tag">For healthcare organisations</p>
      <h2 id="home-deep-h">One API and MCP server for hospital systems.</h2>
      <p>Make an organisation, create API keys for the sandbox hospital, and approve writes before they reach a hospital system. It opens with this sign-in.</p>
      <button className="btn btn--on-deep" onClick={() => setView('console')}>Open the developer console</button>
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

  const steps: { title: string; text: string; done: boolean; actions: ReactNode }[] = [
    {
      title: 'Bring in your records', done: series.length > 0 || mine.length > 0,
      text: 'Connect a lab, hospital, ABHA or a device, and LotusPond fetches your reports. Or upload a PDF or a photo of one.',
      actions: <><button className="btn btn--primary" onClick={() => setView('sources')}>Connect a source</button><button className="btn" onClick={() => setUploadOpen(true)}>{Icon.upload} Upload</button></>,
    },
    {
      title: 'Use them with your AI', done: sees.length > 0,
      text: 'Add LotusPond to Claude, ChatGPT or another agent. You choose whose records it sees.',
      actions: <button className="btn" onClick={() => setView('agents')}>Connect an agent</button>,
    },
    {
      title: 'Book a test at home', done: false,
      text: 'A lab collects the sample at home, and the results come back into your records for you to check.',
      actions: <button className="btn" onClick={() => setView('labs')}>Find a lab</button>,
    },
  ];
  const hello = profile ? `Welcome, ${firstName(profile)}` : 'Welcome';

  return (
    <main className="page home">
      {isNew ? (
        <div className="home-grid">
          <div>
            <div className="page__head"><div><h1>{hello}</h1><p>Your family’s health records in one place, ready for any AI agent you choose. Three steps set it up.</p></div></div>
            <ol className="steps" aria-label="Set up LotusPond Health">
              {steps.map(st => (
                <li key={st.title}>
                  <h3>{st.title} <span className={`home-status${st.done ? ' is-ok' : ''}`}>{st.done ? 'Done' : 'To do'}</span></h3>
                  <p>{st.text}</p>
                  {!st.done && <div className="tools">{st.actions}</div>}
                </li>
              ))}
            </ol>
          </div>
          <div className="home-side"><ForOrganisations /></div>
        </div>
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
            <section aria-labelledby="home-setup-h">
              <h2 id="home-setup-h" className="home-side__title">{name}</h2>
              <ul className="home-rows">
                <Row title="Sources" icon={Icon.file} action={{ label: mine.length ? 'Open' : 'Connect', view: 'sources' }}
                  status={connections === null ? null : needSignIn > 0 ? { label: 'Sign in again', ok: false } : mine.length ? { label: 'Connected', ok: true } : { label: 'None yet', ok: false }}>
                  {connections === null ? <p className="note">Loading…</p>
                    : mine.length ? <p>{mine.length} connected{lastCheck ? `, last checked ${formatDate(lastCheck)}` : ''}.{needSignIn > 0 ? ` ${needSignIn} need${needSignIn === 1 ? 's' : ''} you to sign in again.` : ''}</p>
                    : <p className="note">Connect a lab, hospital, ABHA or a device to bring reports in.</p>}
                </Row>
                <Row title="Agents" icon={Icon.agent} action={agentServer ? { label: sees.length ? 'Open' : 'Connect', view: 'agents' } : undefined}
                  status={!agentServer || agents === null ? null : sees.length ? { label: `${sees.length} can see`, ok: true } : { label: 'None yet', ok: false }}>
                  {!agentServer ? <p className="note">Agents connect to the LotusPond server; this preview has none.</p>
                    : agents === null ? <p className="note">Loading…</p>
                    : sees.length ? <p>{sees.slice(0, 3).map(a => a.name).join(', ')}{sees.length > 3 ? '…' : ''}.</p>
                    : <p className="note">No agent can see these records. Add LotusPond to Claude, ChatGPT or another agent.</p>}
                </Row>
                <Row title="Labs" icon={Icon.pin} action={{ label: labResults ? 'Check' : 'Find a lab', view: 'labs' }}
                  status={labResults ? { label: `${labResults} to check`, ok: false } : null}>
                  {labResults ? <p>{labResults} lab result{labResults === 1 ? '' : 's'} waiting for you to check.</p>
                    : <p className="note">Book a sample collection at home, or find a lab, imaging centre or hospital near you.</p>}
                </Row>
              </ul>
            </section>
            <ForOrganisations />
          </div>
        </div>
      )}
    </main>
  );
}
