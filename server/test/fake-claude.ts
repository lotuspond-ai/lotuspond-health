// A stand-in for the Claude API's streaming responses: one scripted turn as server-sent events, as the real API
// sends them (a thinking block first, then text, then tool uses), for the real SDK to read.

/** One scripted model turn: text, then tool uses. */
export type Script = { text?: string; tools?: { name: string; input: unknown }[]; stop?: string };

export function sse(turn: Script, n: number): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data as object })}\n\n`;
  let out = ev('message_start', { message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  let i = 0;
  // A thinking block first, as Claude Opus 5.5 returns them (empty text by default): it must be stored and replayed.
  out += ev('content_block_start', { index: i, content_block: { type: 'thinking', thinking: '', signature: '' } });
  out += ev('content_block_delta', { index: i, delta: { type: 'signature_delta', signature: `sig${n}` } });
  out += ev('content_block_stop', { index: i++ });
  if (turn.text) {
    out += ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
    for (const part of turn.text.match(/.{1,12}/g) ?? []) out += ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: part } });
    out += ev('content_block_stop', { index: i++ });
  }
  for (const [k, t] of (turn.tools ?? []).entries()) {
    out += ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: `toolu_${n}_${k}`, name: t.name, input: {} } });
    out += ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input) } });
    out += ev('content_block_stop', { index: i++ });
  }
  out += ev('message_delta', { delta: { stop_reason: turn.stop ?? (turn.tools?.length ? 'tool_use' : 'end_turn'), stop_sequence: null }, usage: { output_tokens: 20 } });
  out += ev('message_stop', {});
  return out;
}
