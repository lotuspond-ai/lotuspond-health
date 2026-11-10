// Agent connections: how AI agents (Claude, ChatGPT, Grok, Gemini, Meta AI, your own) reach a person's health
// records through the Model Context Protocol. Shared by the API (server/src/agents/) and the app (Account page).

/**
 * What a connection may do.
 * - `health:read`: profile details, results and trends, scans and files (names and dates, never the files), and
 *   the health summary.
 * - `health:write`: add what the person tells the agent: a reading (blood pressure, weight, glucose…) or a
 *   condition, medication or allergy. Every entry is marked with the agent that added it.
 */
export type AgentScope = 'health:read' | 'health:write';

export const AGENT_SCOPES: readonly AgentScope[] = ['health:read', 'health:write'];

export const AGENT_SCOPE_TEXT: Record<AgentScope, { title: string; detail: string }> = {
  'health:read': {
    title: 'Read health records',
    detail: 'Profile details, lab results and their trends, the list of scans and files, and a summary of what stands out.',
  },
  'health:write': {
    title: 'Add to health records',
    detail: 'Readings you tell it (blood pressure, weight, glucose) and conditions, medications or allergies, each marked as added by this agent.',
  },
};

/** How the connection was made: OAuth sign-in from the agent (Claude, ChatGPT…) or a token created on Account. */
export type AgentConnectionKind = 'oauth' | 'token';

/** One connected agent, as the Account page lists it. Never includes a token. */
export interface AgentConnection {
  id: string;
  kind: AgentConnectionKind;
  /** The agent's own name (OAuth) or the label given to the token. */
  name: string;
  /** Where an OAuth client sends people back to (its host), to tell look-alike names apart. */
  redirectHost: string | null;
  scopes: AgentScope[];
  /** Profiles the agent may see. */
  profileIds: string[];
  createdAt: string;
  lastUsedAt: string | null;
  /** Access tokens made on Account can expire; OAuth connections renew themselves until revoked. */
  expiresAt: string | null;
}

export interface CreateAgentTokenInput {
  name: string;
  scopes: AgentScope[];
  profileIds: string[];
  /** Days until it stops working; null for no expiry. */
  expiresInDays: number | null;
}

/** The token is shown once and cannot be read back. */
export interface CreatedAgentToken {
  connection: AgentConnection;
  token: string;
  /** The MCP endpoint to give the agent. */
  mcpUrl: string;
}

/** What /api/agents returns: the connections and the address agents connect to. */
export interface AgentConnectionsInfo {
  mcpUrl: string;
  connections: AgentConnection[];
}

/** Path of the MCP endpoint on the API host. */
export const MCP_PATH = '/mcp';
