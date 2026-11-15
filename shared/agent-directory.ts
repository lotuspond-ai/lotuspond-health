// How to connect each AI agent to LotusPond (Account, Connected agents; docs/agents.md). Every agent that speaks MCP
// uses the same address (`<server>/mcp`): those that sign in with OAuth need nothing else, the others take an access
// token made on Account. Assistants with no way to add a custom connector get a summary to paste instead.
//
// Products change their menus often. Steps here are as of November 2026; where a product's support depends on the
// plan or is not confirmed, the step says so rather than promising it.
import type { HealthSummary } from './synthesis.ts';

export type AgentConnectKind =
  /** A remote MCP connector added in the product's settings; it opens LotusPond's sign-in (OAuth). */
  | 'connector'
  /** A tool configured with the address (JSON, TOML or a command); OAuth where it supports it, else a token. */
  | 'config'
  /** A developer API that calls remote MCP servers; send an access token. */
  | 'api'
  /** No custom connectors: paste a summary of the records into the chat. */
  | 'paste';

export interface AgentDirectoryEntry {
  id: string;
  name: string;
  maker: string;
  group: 'assistants' | 'developer' | 'apis' | 'personal';
  kind: AgentConnectKind;
  /** Steps, with {url} where the MCP address goes. */
  steps: string[];
  /** A configuration block, with {url} and {token} placeholders. */
  snippet?: string;
  /** Whether it needs an access token made on Account (no OAuth sign-in). */
  token?: boolean;
  note?: string;
}

export const AGENT_GROUP_TEXT: Record<AgentDirectoryEntry['group'], string> = {
  assistants: 'Chat assistants',
  developer: 'Coding and desktop agents',
  apis: 'APIs and automation',
  personal: 'Personal and self-hosted agents',
};

const JSON_HTTP = `{
  "mcpServers": {
    "lotuspond-health": { "type": "http", "url": "{url}" }
  }
}`;

export const AGENT_DIRECTORY: AgentDirectoryEntry[] = [
  /* ---------------- chat assistants ---------------- */
  { id: 'claude', name: 'Claude', maker: 'Anthropic', group: 'assistants', kind: 'connector',
    steps: ['Open Claude (web, desktop or mobile): Settings, Connectors, Add custom connector.', 'Paste {url} and add it.', 'Claude opens LotusPond: sign in, choose whose records it sees and what it may do.'] },
  { id: 'chatgpt', name: 'ChatGPT', maker: 'OpenAI', group: 'assistants', kind: 'connector',
    steps: ['In ChatGPT: Settings, Apps and connectors, Advanced settings, turn on Developer mode.', 'Create a connector: paste {url}, authentication OAuth.', 'Sign in to LotusPond when ChatGPT asks, and choose what it may see.'],
    note: 'Custom connectors depend on your ChatGPT plan; OpenAI decides which plans offer them.' },
  { id: 'le-chat', name: 'Le Chat', maker: 'Mistral AI', group: 'assistants', kind: 'connector',
    steps: ['In Le Chat: Intelligence, Connectors, Add connector, Custom MCP connector.', 'Paste {url}; Le Chat opens the LotusPond sign-in.'],
    note: 'Where your Le Chat plan offers custom connectors.' },
  { id: 'copilot', name: 'Microsoft Copilot Studio', maker: 'Microsoft', group: 'assistants', kind: 'connector',
    steps: ['In your agent: Tools, Add a tool, Model Context Protocol.', 'Give {url}, authentication OAuth 2.0 (dynamic discovery), or an API key with a LotusPond access token.'],
    note: 'Copilot Studio agents (work accounts). The consumer Copilot app has no custom connectors: use the summary below.' },
  { id: 'gemini', name: 'Gemini', maker: 'Google', group: 'assistants', kind: 'paste',
    steps: ['The Gemini app does not take custom MCP connectors today. Copy the summary below and paste it into your chat.', 'Gemini CLI can connect directly: see Gemini CLI.'] },
  { id: 'grok', name: 'Grok', maker: 'xAI', group: 'assistants', kind: 'connector',
    steps: ['On grok.com: Connectors, New connector, Custom.', 'Paste {url} and add it; Grok opens the LotusPond sign-in, where you choose what it may see.'],
    note: 'Custom connectors depend on your Grok plan; on Grok Business an admin adds the connector for the team first.' },
  { id: 'meta-ai', name: 'Meta AI', maker: 'Meta', group: 'assistants', kind: 'paste',
    steps: ['Meta AI (in its app, WhatsApp, Instagram and Messenger) has no custom connectors that we know of. Copy the summary below and paste it in.'] },
  { id: 'perplexity', name: 'Perplexity', maker: 'Perplexity', group: 'assistants', kind: 'paste',
    steps: ['If your Perplexity app offers custom connectors, add {url}. Otherwise copy the summary below and paste it in.'] },

  /* ---------------- coding and desktop agents ---------------- */
  { id: 'claude-code', name: 'Claude Code', maker: 'Anthropic', group: 'developer', kind: 'config',
    steps: ['Run: claude mcp add --transport http lotuspond {url}', 'In Claude Code, run /mcp and sign in to LotusPond.'] },
  { id: 'claude-desktop', name: 'Claude Desktop (config file)', maker: 'Anthropic', group: 'developer', kind: 'config', token: true,
    steps: ['Easiest: add it as a connector in Settings, Connectors (see Claude).', 'Or create an access token below and add this to claude_desktop_config.json:'],
    snippet: `{
  "mcpServers": {
    "lotuspond-health": { "type": "http", "url": "{url}", "headers": { "Authorization": "Bearer {token}" } }
  }
}` },
  { id: 'codex', name: 'Codex CLI', maker: 'OpenAI', group: 'developer', kind: 'config',
    steps: ['Add to ~/.codex/config.toml, then run: codex mcp login lotuspond'],
    snippet: `[mcp_servers.lotuspond]
url = "{url}"`, note: 'Needs a recent Codex version with remote (HTTP) MCP servers.' },
  { id: 'gemini-cli', name: 'Gemini CLI', maker: 'Google', group: 'developer', kind: 'config',
    steps: ['Add to ~/.gemini/settings.json, start Gemini CLI and run /mcp auth lotuspond.'],
    snippet: `{
  "mcpServers": {
    "lotuspond": { "httpUrl": "{url}" }
  }
}` },
  { id: 'cursor', name: 'Cursor', maker: 'Anysphere', group: 'developer', kind: 'config',
    steps: ['Settings, MCP, Add new MCP server (or edit ~/.cursor/mcp.json):'], snippet: JSON_HTTP },
  { id: 'vscode', name: 'VS Code (GitHub Copilot agent mode)', maker: 'Microsoft', group: 'developer', kind: 'config',
    steps: ['Command palette: MCP: Add Server, HTTP, paste {url}. Or add to .vscode/mcp.json:'],
    snippet: `{
  "servers": {
    "lotuspond-health": { "type": "http", "url": "{url}" }
  }
}` },
  { id: 'windsurf', name: 'Windsurf', maker: 'Windsurf', group: 'developer', kind: 'config',
    steps: ['Add to ~/.codeium/windsurf/mcp_config.json:'], snippet: `{
  "mcpServers": {
    "lotuspond-health": { "serverUrl": "{url}" }
  }
}` },
  { id: 'goose', name: 'Goose, Zed, LM Studio and other MCP clients', maker: 'Various', group: 'developer', kind: 'config',
    steps: ['Add a remote MCP server of type HTTP (Streamable HTTP) with {url}.', 'Clients that cannot sign in with OAuth: create an access token below and send it as Authorization: Bearer.'] },

  /* ---------------- APIs and automation ---------------- */
  { id: 'claude-api', name: 'Claude API (MCP connector)', maker: 'Anthropic', group: 'apis', kind: 'api', token: true,
    steps: ['Create an access token below, then pass LotusPond as an MCP server in the Messages API:'],
    snippet: `"mcp_servers": [
  { "type": "url", "url": "{url}", "name": "lotuspond", "authorization_token": "{token}" }
]` },
  { id: 'openai-api', name: 'OpenAI API (Responses)', maker: 'OpenAI', group: 'apis', kind: 'api', token: true,
    steps: ['Create an access token below, then add LotusPond as a remote MCP tool:'],
    snippet: `"tools": [
  { "type": "mcp", "server_label": "lotuspond", "server_url": "{url}", "headers": { "Authorization": "Bearer {token}" }, "require_approval": "always" }
]` },
  { id: 'xai-api', name: 'Grok API (xAI)', maker: 'xAI', group: 'apis', kind: 'api', token: true,
    steps: ['Create an access token below, then add LotusPond as a remote MCP tool in your xAI request (server URL {url}, Authorization: Bearer with the token).'],
    note: 'See xAI’s documentation for the exact field names of remote MCP tools.' },
  { id: 'automation', name: 'n8n, Zapier, Make', maker: 'Various', group: 'apis', kind: 'api', token: true,
    steps: ['Use the tool’s MCP client step with {url} and a LotusPond access token as a Bearer header.', 'Keep a write permission off unless the workflow must add readings.'] },

  /* ---------------- personal and self-hosted agents ---------------- */
  { id: 'grok-bot', name: 'Grok Bot', maker: 'xAI', group: 'personal', kind: 'config', token: true,
    steps: ['Create an access token below.', 'Ask a Bot: "Add a custom remote MCP server named LotusPond Health, URL {url}, with the HTTP header Authorization: Bearer {token}".', 'Check the approval card Grok Bot shows (name, URL and header), then save.'] },
  { id: 'muse', name: 'Muse', maker: 'Meta', group: 'personal', kind: 'config', token: true,
    steps: ['Create an access token below.', 'Ask Muse: "Create a custom connector for the LotusPond Health MCP server at {url}, using Streamable HTTP and the header Authorization: Bearer".', 'Enter the token when Muse asks for it in its secure prompt.', 'Muse Code: add {url} to mcp_servers in ~/.config/muse/settings.json with the same header.'],
    note: 'Muse is rolling out in the US. Meta does not review custom connectors; Muse writes its own for each service.' },
  { id: 'personal', name: 'Your own or personal agent', maker: 'You', group: 'personal', kind: 'config', token: true,
    steps: ['Any agent framework with an MCP client (OpenAI Agents SDK, Claude Agent SDK, LangChain, LlamaIndex, OpenClaw and others).', 'Create an access token below and connect to {url} with Authorization: Bearer.'],
    snippet: `{
  "mcpServers": {
    "lotuspond-health": { "type": "http", "url": "{url}", "headers": { "Authorization": "Bearer {token}" } }
  }
}` },
];

export const fillAgentText = (text: string, url: string, token = '<your access token>') => text.replaceAll('{url}', url).replaceAll('{token}', token);

const fmtDate = (d: string | null | undefined) => d ?? 'no date';

/**
 * The summary as plain text, for assistants without connectors: who it is, what stands out, what is changing and
 * what may be due. It carries the same disclaimer agents get, and a line asking the assistant not to diagnose.
 */
export function summaryForChat(s: HealthSummary): string {
  const p = s.profile;
  const lines: string[] = [];
  lines.push(`Health summary from LotusPond Health for ${p.name}${p.relationship === 'self' ? '' : ` (${p.relationship})`}.`);
  const facts = [p.ageYears != null ? `${p.ageYears} years old` : null, p.sex, p.bmi != null ? `BMI ${p.bmi}` : null, p.bloodType ? `blood type ${p.bloodType}` : null].filter(Boolean);
  if (facts.length) lines.push(facts.join(', ') + '.');
  if (p.conditions?.length) lines.push(`Conditions: ${p.conditions.join(', ')}.`);
  if (p.medications?.length) lines.push(`Medications: ${p.medications.join(', ')}.`);
  if (p.allergies?.length) lines.push(`Allergies: ${p.allergies.join(', ')}.`);
  if (s.outOfRange) {
    lines.push('', s.outOfRange.length ? 'Results outside their range (latest):' : 'No results outside their range.');
    for (const m of s.outOfRange) {
      lines.push(`- ${m.marker}: ${m.latest.text} ${m.latest.unit} (${m.latest.status}; range ${m.latest.range ?? 'not given'}) on ${fmtDate(m.latest.date)}${m.previous ? `, previously ${m.previous.value ?? '?'} on ${fmtDate(m.previous.date)}` : ''}`);
    }
  }
  if (s.changing?.length) {
    lines.push('', 'Changing:');
    for (const m of s.changing) lines.push(`- ${m.marker}: ${m.trend}, ${m.direction === 'toward_range' ? 'moving toward its range' : 'moving away from its range'} (latest ${m.latest.text} ${m.latest.unit}, ${fmtDate(m.latest.date)})`);
  }
  if (s.followUps?.length) {
    lines.push('', 'May be due:');
    for (const f of s.followUps) lines.push(`- ${f.marker}: ${f.reason}`);
  }
  if (s.counts.results != null) lines.push('', `${s.counts.results} results across ${s.counts.markers ?? 0} markers${s.lastResultDate ? `, latest ${s.lastResultDate}` : ''}.`);
  lines.push('', s.disclaimer, 'Please explain these results in plain words and suggest questions for a clinician. Do not diagnose or recommend changing medicines.');
  return lines.join('\n');
}
