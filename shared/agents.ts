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
    detail: 'What you choose under "What it may see", and a summary of what stands out in it.',
  },
  'health:write': {
    title: 'Add to health records',
    detail: 'Readings you tell it (blood pressure, weight, glucose) and conditions, medications or allergies, each marked as added by this agent.',
  },
};

/**
 * Which kinds of health data a connection may see, on top of the basics every connection gets (name, relationship,
 * age, sex, height, weight, BMI and blood type). Writes follow them too: adding a reading needs `results`, adding a
 * condition, medication or allergy needs `conditions`.
 */
export type AgentCategory = 'results' | 'conditions' | 'files' | 'labs';

export const AGENT_CATEGORIES: readonly AgentCategory[] = ['results', 'conditions', 'files', 'labs'];

export const AGENT_CATEGORY_TEXT: Record<AgentCategory, { title: string; detail: string }> = {
  results: { title: 'Lab results and readings', detail: 'Values, ranges and trends, what stands out, and readings such as blood pressure.' },
  conditions: { title: 'Conditions, medications and allergies', detail: 'Including the notes on the profile.' },
  files: { title: 'List of scans and files', detail: 'Names, types and dates only. Never the files or images.' },
  labs: { title: 'Home lab tests', detail: 'Tests offered near the home area, bookings and their status, and proposing a booking you confirm in the app.' },
};

/** What every connection sees about a shared profile, whatever the categories. */
export const AGENT_BASICS_TEXT = 'Every connection sees the name, relationship, age, sex, height, weight, BMI and blood type of the profiles shared with it.';

/** How long an OAuth connection lasts, as offered on the consent page and Account (days; null until disconnected). */
export const AGENT_EXPIRY_CHOICES: readonly { days: number | null; label: string }[] = [
  { days: 30, label: '30 days' }, { days: 90, label: '90 days' }, { days: 365, label: 'A year' }, { days: null, label: 'Until I disconnect it' },
];

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
  /** The kinds of data it may see (all of them for connections made before categories existed). */
  categories: AgentCategory[];
  /** Profiles the agent may see. */
  profileIds: string[];
  createdAt: string;
  lastUsedAt: string | null;
  /** When it stops working; null for never (until disconnected). */
  expiresAt: string | null;
}

export interface CreateAgentTokenInput {
  name: string;
  scopes: AgentScope[];
  /** Defaults to every category. */
  categories?: AgentCategory[];
  profileIds: string[];
  /** Days until it stops working; null for no expiry. */
  expiresInDays: number | null;
}

/** A change to a connection; expiresInDays counts from now, null removes the expiry. */
export interface UpdateAgentConnectionInput {
  scopes?: AgentScope[];
  categories?: AgentCategory[];
  profileIds?: string[];
  expiresInDays?: number | null;
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
