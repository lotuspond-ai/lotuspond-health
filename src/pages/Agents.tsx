// Agents: the AI agents a person lets read (and, if they allow it, add to) their family's records, the LotusPond
// assistant, and WhatsApp. One of the two things LotusPond Health is for: records from anywhere, used by the agents
// you choose.
import { AgentConnectionsPanel } from '../components/AgentConnections';
import { isPreview } from '../api';

export default function Agents() {
  return (
    <main className="page page--narrow">
      <div className="page__head">
        <div>
          <h1>Agents</h1>
          <p>Use your records with Claude, ChatGPT, Gemini or any agent you choose. You decide whose records each one sees, and you can disconnect it at any time.</p>
        </div>
      </div>
      <div className="stack">
        {isPreview
          ? <section className="panel"><p className="note">Connecting agents needs the LotusPond server. This preview keeps everything in your browser, so agents cannot reach it.</p></section>
          : <AgentConnectionsPanel />}
      </div>
    </main>
  );
}
