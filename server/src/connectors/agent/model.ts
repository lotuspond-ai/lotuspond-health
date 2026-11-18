// The computer-use model behind tasks.run: OpenAI's Responses API with its built-in computer tool, GPT-6.1 Terra by
// default (ORG_AGENT_MODEL). Written from OpenAI's computer-use guide (developers.openai.com, read 18 November 2026):
//
//   tools   [{ type: "computer", display_width, display_height, environment: "browser" }, function tools…]
//   output  computer_call { call_id, actions: [{ type: click|double_click|scroll|type|keypress|move|drag|wait|screenshot, … }],
//                           pending_safety_checks }
//           function_call { call_id, name, arguments }   message { content: [{ type: output_text, text }] }
//   reply   computer_call_output { call_id, output: { type: computer_screenshot, image_url: data:image/png;base64,…, detail } }
//           function_call_output { call_id, output }, chained with previous_response_id
//
// A safety check the model raises is never acknowledged here: the task stops for a person (agent/run.ts). Screenshots
// of the system's web app go to OpenAI, so a live connection needs OpenAI under a data processing agreement with zero
// data retention (docs/connectors.md).
export interface ComputerAction {
  type: string;
  x?: number;
  y?: number;
  button?: string;
  text?: string;
  keys?: string[];
  scroll_x?: number;
  scroll_y?: number;
  path?: ({ x: number; y: number } | [number, number])[];
}

export interface ComputerCall { callId: string; actions: ComputerAction[]; safetyChecks: { id: string; code?: string; message?: string }[] }
export interface FinishCall { callId: string; outcome: 'done' | 'cannot' | 'needs_sign_in'; summary: string }

export interface ModelTurn {
  responseId: string;
  computerCalls: ComputerCall[];
  finish: FinishCall | null;
  /** Anything the model said in plain text this turn. */
  text: string;
}

export type ModelReply =
  | { kind: 'screenshot'; callId: string; png: Buffer }
  | { kind: 'function'; callId: string; output: string }
  | { kind: 'user'; text: string };

export interface ComputerModel {
  name: string;
  start(o: { instructions: string; task: string; screenshot: Buffer; display: { width: number; height: number } }): Promise<ModelTurn>;
  next(o: { previous: string; replies: ModelReply[]; instructions: string; display: { width: number; height: number } }): Promise<ModelTurn>;
}

/** The model could not be reached or refused the request; the message is safe to show. */
export class ModelError extends Error {}

const FINISH_TOOL = {
  type: 'function',
  name: 'finish_task',
  description: 'Call this once, when the task is done, cannot be done as asked, or the web app wants someone to sign in. Do not call it before checking on screen that the change was saved.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['outcome', 'summary'],
    properties: {
      outcome: { type: 'string', enum: ['done', 'cannot', 'needs_sign_in'], description: 'done: the task is complete and you saw it saved. cannot: it cannot be done as asked (say why). needs_sign_in: the app shows a sign-in page.' },
      summary: { type: 'string', description: 'What you did and what the screen showed at the end, in one to three sentences, for the clinic staff. Name the record you changed.' },
    },
  },
};

type Json = Record<string, unknown>;

function parseTurn(body: Json): ModelTurn {
  const out = Array.isArray(body.output) ? body.output as Json[] : [];
  const computerCalls: ComputerCall[] = [];
  let finish: FinishCall | null = null;
  const text: string[] = [];
  for (const item of out) {
    if (item.type === 'computer_call' && typeof item.call_id === 'string') {
      // GA responses batch actions[]; the preview shape had a single action.
      const actions = Array.isArray(item.actions) ? item.actions as ComputerAction[] : item.action ? [item.action as ComputerAction] : [];
      const checks = Array.isArray(item.pending_safety_checks) ? item.pending_safety_checks as ComputerCall['safetyChecks'] : [];
      computerCalls.push({ callId: item.call_id, actions, safetyChecks: checks });
    } else if (item.type === 'function_call' && item.name === 'finish_task' && typeof item.call_id === 'string') {
      let args: Json = {};
      try { args = JSON.parse(String(item.arguments ?? '{}')) as Json; } catch { /* treated as cannot below */ }
      const outcome = ['done', 'cannot', 'needs_sign_in'].includes(String(args.outcome)) ? args.outcome as FinishCall['outcome'] : 'cannot';
      finish = { callId: item.call_id, outcome, summary: String(args.summary ?? '').slice(0, 2000) };
    } else if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content as Json[]) if (c.type === 'output_text' && typeof c.text === 'string') text.push(c.text);
    }
  }
  return { responseId: String(body.id ?? ''), computerCalls, finish, text: text.join('\n').slice(0, 4000) };
}

export function openAiComputerModel(o: { apiKey: string; apiUrl: string; model: string; fetch?: typeof fetch; timeoutMs?: number }): ComputerModel {
  const doFetch = o.fetch ?? fetch;
  const tools = (display: { width: number; height: number }) => [
    { type: 'computer', display_width: display.width, display_height: display.height, environment: 'browser' },
    FINISH_TOOL,
  ];
  async function create(body: Json): Promise<ModelTurn> {
    let res: Response;
    try {
      res = await doFetch(`${o.apiUrl}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: o.model, truncation: 'auto', parallel_tool_calls: false, ...body }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
      });
    } catch {
      throw new ModelError('The computer-use model could not be reached.');
    }
    const json = await res.json().catch(() => null) as Json | null;
    if (!res.ok || !json) {
      const msg = (json?.error as Json | undefined)?.message;
      console.error(`[org-agent] the model answered ${res.status}${typeof msg === 'string' ? `: ${msg.slice(0, 200)}` : ''}`);
      throw new ModelError(res.status === 429 ? 'The computer-use model is busy. Try the task again later.' : `The computer-use model refused the request (${res.status}).`);
    }
    if (json.status === 'failed' || json.status === 'incomplete') {
      const reason = (json.incomplete_details as Json | undefined)?.reason;
      if (reason !== 'max_output_tokens') throw new ModelError(`The computer-use model stopped (${String(reason ?? json.status)}).`);
    }
    return parseTurn(json);
  }
  const image = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;
  return {
    name: o.model,
    start: ({ instructions, task, screenshot, display }) => create({
      instructions, tools: tools(display),
      input: [{ role: 'user', content: [{ type: 'input_text', text: task }, { type: 'input_image', image_url: image(screenshot), detail: 'original' }] }],
    }),
    next: ({ previous, replies, instructions, display }) => create({
      instructions, tools: tools(display), previous_response_id: previous,
      input: replies.map(r => r.kind === 'screenshot'
        ? { type: 'computer_call_output', call_id: r.callId, output: { type: 'computer_screenshot', image_url: image(r.png), detail: 'original' } }
        : r.kind === 'function'
          ? { type: 'function_call_output', call_id: r.callId, output: r.output }
          : { role: 'user', content: [{ type: 'input_text', text: r.text }] }),
    }),
  };
}
