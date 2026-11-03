// OpenAI request decoding, history normalization and upstream ChatRequest
// construction. Port of app/internal/openai/{decode,messages,history}.go and
// app/internal/upstream/{convert,tools_convert}.go.
//
// Only the structural minimum is rejected (malformed JSON, non-object body,
// missing model/messages): the upstream owns its enums, and an invented 400
// would be a policy the caller never agreed to.

import { renderAssistant, renderResults } from './tools-replay.mjs';

// reasoningEfforts maps magpie's variant keys onto the upstream's
// reasoningEffort values. "instant" is the upstream web client's own lowest
// tier and passes through when a client sends it explicitly.
const REASONING_EFFORTS = { minimal: 'low' };

export class RequestError extends Error {
  constructor(status, message, param = '') {
    super(message);
    this.status = status;
    this.type = 'invalid_request_error';
    this.code = 'invalid_request';
    this.param = param;
  }
}

export function invalid(message) {
  return new RequestError(400, message);
}

// decodeBody parses an OpenAI chat request body string into the fields this
// plugin consumes.
export function decodeBody(bodyStr) {
  let raw;
  try {
    raw = JSON.parse(bodyStr);
  } catch (e) {
    throw invalid(`invalid JSON body: ${e.message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalid('request body must be a JSON object');
  }
  if (typeof raw.model !== 'string' || raw.model === '') throw invalid('model is required');
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw invalid('messages must not be empty');
  }

  let effort = typeof raw.reasoning_effort === 'string' ? raw.reasoning_effort : '';
  if (effort) effort = REASONING_EFFORTS[effort] ?? effort;
  else effort = 'medium';

  const tools = decodeTools(raw);

  return {
    model: raw.model,
    messages: raw.messages,
    stream: raw.stream === true,
    effort,
    tools,
    toolChoice: raw.tool_choice === undefined ? { kind: 'auto' } : parseToolChoice(raw.tool_choice),
    parallelOff: raw.parallel_tool_calls === false,
  };
}

// decodeTools validates the tool fields; unknown shapes are coerced, not
// rejected.
function decodeTools(raw) {
  if (raw.tools === undefined) return [];
  if (!Array.isArray(raw.tools)) throw invalid('tools must be an array of function objects');
  const out = [];
  raw.tools.forEach((t, i) => {
    if (typeof t !== 'object' || t === null) throw invalid(`tools[${i}] must be an object`);
    const name = t?.function?.name;
    if (typeof name !== 'string' || name === '') throw invalid(`tools[${i}].function.name is required`);
    out.push({
      name,
      description: typeof t.function.description === 'string' ? t.function.description : '',
      parameters: t.function.parameters,
    });
  });
  return out;
}

// parseToolChoice normalises the union. An unrecognised value is auto: the
// OpenAI default whenever tools are present.
function parseToolChoice(v) {
  if (typeof v === 'string') {
    if (v === 'none') return { kind: 'none' };
    if (v === 'required') return { kind: 'required' };
    return { kind: 'auto' };
  }
  const name = typeof v?.function?.name === 'string' ? v.function.name : '';
  if (name) return { kind: 'named', name };
  return { kind: 'auto' };
}

// normalizeRole maps OpenAI roles onto the three the upstream accepts; tool
// and function results ride as user turns, an unknown role is user.
function normalizeRole(role) {
  if (role === 'system' || role === 'developer') return 'system';
  if (role === 'assistant') return 'assistant';
  return 'user';
}

// contentTexts extracts the renderable text of a message content value; a
// non-text part becomes a short placeholder naming its type.
export function contentTexts(content) {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return content === '' ? [] : [content];
  if (!Array.isArray(content)) return [];
  const texts = [];
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue;
    if (item.type === 'text') {
      if (typeof item.text === 'string' && item.text !== '') texts.push(item.text);
      continue;
    }
    const ph = mediaPlaceholder(item.type);
    if (ph) texts.push(ph);
  }
  return texts;
}

// A text stand-in for a non-text content part, so an attachment stays visible
// to the model without echoing unbounded attacker-controlled type strings.
function mediaPlaceholder(typ) {
  switch (typ) {
    case 'image_url':
    case 'image':
      return '[image]';
    case 'input_audio':
    case 'audio':
      return '[audio]';
    case 'file':
    case 'document':
      return '[file]';
    case 'video_url':
      return '[video_url]';
    case 'video':
      return '[video]';
    case '':
      return '';
    case undefined:
      return '';
    default: {
      const clipped = String(typ).slice(0, 32).replace(/[\x00-\x1f\x7f]/g, '');
      return `[${clipped}]`;
    }
  }
}

// parseToolCalls decodes an assistant tool_calls array, dropping entries that
// lack an id or a function name; a malformed array yields [].
function parseToolCalls(raw) {
  if (!Array.isArray(raw)) return [];
  const kept = [];
  for (const c of raw) {
    if (typeof c !== 'object' || c === null) continue;
    const name = c?.function?.name;
    if (typeof c.id !== 'string' || c.id === '' || typeof name !== 'string' || name === '') continue;
    kept.push({
      id: c.id,
      type: c.type === '' || c.type === undefined ? 'function' : c.type,
      function: { name, arguments: c.function.arguments },
    });
  }
  return kept;
}

// normalizeHistory flattens messages to the tool-aware history the converter
// needs. A role:"tool" message keeps its tool_call_id; it is a result even
// when its content is empty.
export function normalizeHistory(msgs) {
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const texts = contentTexts(m.content);

    if (m.role === 'tool') {
      out.push({
        role: 'user',
        results: [{ callId: typeof m.tool_call_id === 'string' ? m.tool_call_id : '', content: texts.join('') }],
      });
      continue;
    }

    const calls = m.role === 'assistant' ? parseToolCalls(m.tool_calls) : [];
    if (texts.length === 0 && calls.length === 0) {
      throw new RequestError(400, `messages[${i}] (${m.role}) has no text content`, `messages[${i}].content`);
    }
    const h = { role: normalizeRole(m.role), texts, calls: [] };
    if (m.role === 'assistant') h.calls = calls;
    out.push(h);
  }
  return out;
}

// RandomID: "<prefix>-<12 hex chars>", cosmetic.
export function randomId(prefix) {
  return `${prefix}-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function textParts(role, texts) {
  // Assistant parts are "done": the upstream web client's state rule.
  return texts.map((text) => (role === 'assistant' ? { type: 'text', text, state: 'done' } : { type: 'text', text }));
}

// buildChatRequest: the plain (no tools) upstream body. Web search stays ON:
// the client declared no tools, so the upstream's builtin search is the
// client's search.
export function buildChatRequest(textMsgs, effort) {
  return {
    reasoningEffort: effort || 'medium',
    webSearchEnabled: true,
    voiceMode: false,
    timezone: 'UTC',
    language: 'en-US',
    id: randomId('c'),
    trigger: 'submit-message',
    messages: textMsgs.map((m) => ({ parts: textParts(m.role, m.texts), id: randomId('m'), role: m.role })),
  };
}

// buildToolChatRequest: the tool-bearing upstream body. The tool preamble is
// a system message before everything else; assistant calls replay as
// <tool_call> blocks in their own turn; consecutive tool results group into
// one user turn.
//
// Web search is OFF whenever a tool manifest is present (measured 2026-10-22:
// with webSearchEnabled:true the upstream injects its own server-side tool
// definitions and the two catalogues conflict — 3/3 empty answers; the same
// preamble with webSearchEnabled:false answered with a clean call block).
export function buildToolChatRequest(hist, effort, manifest) {
  const converted = [];
  if (manifest?.preamble) {
    converted.push({ parts: [{ type: 'text', text: manifest.preamble }], id: randomId('m'), role: 'system' });
  }

  // call id -> function name, so a tool result can be labelled.
  const names = new Map();
  for (const h of hist) {
    for (const c of h.calls ?? []) names.set(c.id, c.function.name);
  }

  for (let i = 0; i < hist.length; i++) {
    const h = hist[i];

    if ((h.results?.length ?? 0) > 0) {
      // Group this run of consecutive results into one user turn.
      const results = [];
      for (; i < hist.length && (hist[i].results?.length ?? 0) > 0; i++) {
        for (const r of hist[i].results) {
          results.push({ callId: r.callId, name: names.get(r.callId), content: r.content });
        }
      }
      i--;
      converted.push({ parts: textParts('user', [renderResults(results)]), id: randomId('m'), role: 'user' });
      continue;
    }

    let texts;
    if ((h.calls?.length ?? 0) > 0) {
      const rendered = renderAssistant((h.texts ?? []).join(''), h.calls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })));
      texts = rendered === '' ? [] : [rendered];
    } else {
      texts = h.texts;
    }
    if (!texts || texts.length === 0) continue;
    converted.push({ parts: textParts(h.role, texts), id: randomId('m'), role: h.role });
  }

  return {
    reasoningEffort: effort || 'medium',
    webSearchEnabled: manifest == null,
    voiceMode: false,
    timezone: 'UTC',
    language: 'en-US',
    id: randomId('c'),
    trigger: 'submit-message',
    messages: converted,
  };
}
