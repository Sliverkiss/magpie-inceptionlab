// History replay rendering: assistant turns with calls, user turns with tool
// results. Port of app/internal/tools/replay.go.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// NewID mints an OpenAI-shaped tool-call id: "call_" plus 24 alphanumerics.
// Cosmetic, never used for security.
export function newCallId() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  let s = 'call_';
  for (const v of b) s += ALPHABET[v % ALPHABET.length];
  return s;
}

// RenderAssistant renders an assistant turn's text plus its calls as the
// upstream should see it: the same marker block the preamble teaches, with
// the call id added so a following tool result can be associated.
export function renderAssistant(text, calls) {
  if (!calls || calls.length === 0) return text;
  let out = text;
  let needNL = out.length > 0 && !text.endsWith('\n');
  for (const c of calls) {
    if (needNL) out += '\n';
    needNL = false;
    out += `<tool_call>{"id":${JSON.stringify(c.id)},"name":${JSON.stringify(c.name)},"arguments":${argumentsAsJSON(c.arguments)}}</tool_call>\n`;
  }
  return out.replace(/\n+$/, '');
}

// argumentsAsJSON embeds a client-supplied arguments string as a JSON value
// when it is an object, and as a JSON string otherwise — the replayed block
// stays syntactically valid even when the client echoed garbage.
function argumentsAsJSON(raw) {
  const trimmed = (raw ?? '').trim();
  if (trimmed.startsWith('{')) {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      /* fall through */
    }
  }
  return JSON.stringify(raw ?? '');
}

// resultContract breaks the narrate-no-call stall: after consuming a tool
// result the model sometimes ends its turn with a plan narration and no call
// block — a self-reinforcing pattern once one such turn is in history.
const RESULT_CONTRACT = '[End of tool result. If the task is not complete, call the next tool now — narration alone is not a valid turn.]';

// RenderResults renders one or more tool results as a single user turn. The
// upstream has no tool role; results ride in a user message. Bracket headers
// close blocks no result body can forge, and the contract trailer appears
// once per turn, after the last result.
export function renderResults(results) {
  return results
    .map((r, i) => {
      let s = '[Tool Result';
      if (r.callId) s += ` id="${attrEscape(r.callId)}"`;
      if (r.name) s += ` name="${attrEscape(r.name)}"`;
      s += `]\n${r.content}\n`;
      s += i === results.length - 1 ? RESULT_CONTRACT : '[End of tool result]';
      return s;
    })
    .join('\n');
}

// attrEscape makes a value safe inside a double-quoted bracket attribute: it
// replaces the characters that could terminate the attribute or forge a new
// line with visible substitutes. XML entity escaping is intentionally NOT
// applied — the block is not XML.
function attrEscape(s) {
  return s.replaceAll('"', "'").replaceAll(']', '〕').replaceAll('\n', ' ').replaceAll('\r', ' ');
}
