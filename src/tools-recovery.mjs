// Classification of a zero-call round and the recovery retry messages.
// Port of app/internal/tools/recovery.go.
//
// Philosophy: the gateway translates, never blocks. Clean prose is a legal
// terminal answer and is never retried; only an output that opens a call
// envelope it never closes, or closes one whose body did not parse, is
// retry-worthy.

export const RECOVERY_CLEAN = 'clean';
export const RECOVERY_TRUNCATED = 'truncated';
export const RECOVERY_PARSE_FAILED = 'parse_failed';
export const RECOVERY_REFUSED = 'refused';
export const RECOVERY_UNDECLARED = 'undeclared';

// retrySnippetLimit bounds the original-output tail embedded in a retry
// message, so a long broken round cannot balloon the retry turn.
const RETRY_SNIPPET_LIMIT = 2000;

// Foreign envelope shapes the upstream model was observed reproducing, each
// with its closer. A detector that does not recognize a marker leaves it
// uncounted.
const FOREIGN_ENVELOPES = [
  ['<tool_calls>', '</tool_calls>'],
  ['<tool_use>', '</tool_use>'],
];
const FOREIGN_JSON_OPENERS = ['"tool_calls":', 'function.name:'];

// classifyNoCall classifies a round that produced zero parsed calls.
//
// Truncation is decided two ways, matching the live failure modes:
//  1. an opened envelope without a matching close — nOpen > nClose over the
//     relevant markers;
//  2. an open JSON tail: the last non-space char is , : { or [ AND the tail
//     holds unbalanced {/[ — brace-guarded so prose ending in a colon stays
//     clean.
//
// A CALL_BLOCKED envelope that closed cleanly but whose body names an
// undeclared tool is UNDECLARED — distinct from parse_failed: the model wrote
// a well-formed call for a tool that does not exist. Echoing that block back
// as an assistant turn would reinforce the hallucination on the retry.
//
// Empty text is clean: the empty-answer retry is separate behavior.
export function classifyNoCall(text, declared) {
  if (!text || !text.trim()) return RECOVERY_CLEAN;

  // The refusal shape is checked FIRST: a canned refusal arrives as plain
  // prose, so the envelope logic below would call it clean and pass the
  // refusal through verbatim — the main channel through which refusals
  // reached users.
  if (classifyRefusal(text)) return RECOVERY_REFUSED;

  let nOpen = count(text, '<tool_call>');
  let nClose = count(text, '</tool_call>');
  let foreignSeen = false;
  for (const [open, close] of FOREIGN_ENVELOPES) {
    const n = count(text, open);
    nOpen += n;
    foreignSeen = foreignSeen || n > 0;
    nClose += count(text, close);
  }
  for (const probe of FOREIGN_JSON_OPENERS) {
    // Only at a line start: a mention inside prose (the user asking "what is
    // function.name:" or a code sample) is not an envelope attempt.
    const n = countAtLineStart(text, probe);
    nOpen += n;
    foreignSeen = foreignSeen || n > 0;
  }
  const opened = nOpen > 0;
  if (opened && nOpen > nClose) return RECOVERY_TRUNCATED;

  const trimmed = text.trim();
  const last = lastNonSpace(trimmed);
  if (last === ',' || last === ':' || last === '{' || last === '[') {
    if (unbalancedJSONTail(trimmed)) return RECOVERY_TRUNCATED;
  }

  if (opened) {
    if (hasUndeclaredCall(text, declared)) return RECOVERY_UNDECLARED;
    return RECOVERY_PARSE_FAILED;
  }
  if (foreignSeen) return RECOVERY_PARSE_FAILED;
  return RECOVERY_CLEAN;
}

// hasUndeclaredCall reports whether any complete <tool_call> block holds
// a JSON call whose name is not in the declared set.
function hasUndeclaredCall(text, declared) {
  const names = new Set(declared ?? []);
  let i = 0;
  for (;;) {
    const s = text.indexOf('<tool_call>', i);
    if (s < 0) return false;
    const e = text.indexOf('</tool_call>', s);
    if (e < 0) return false;
    const body = text.slice(s + '<tool_call>'.length, e).trim();
    try {
      const raw = JSON.parse(body);
      if (raw && typeof raw === 'object' && typeof raw.name === 'string') {
        if (!names.has(raw.name)) return true;
      }
    } catch { /* not a parseable body — the parse_failed path owns it */ }
    i = e + '</tool_call>'.length;
  }
}

// countAtLineStart counts sub occurrences preceded only by whitespace since
// the previous newline (or at offset 0).
function countAtLineStart(s, sub) {
  let n = 0, i = 0;
  for (;;) {
    i = s.indexOf(sub, i);
    if (i < 0) return n;
    let j = i - 1;
    while (j >= 0 && (s[j] === ' ' || s[j] === '\t')) j--;
    if (j < 0 || s[j] === '\n' || s[j] === '\r') n++;
    i += sub.length;
  }
}

// unbalancedJSONTail reports whether s holds more opening than closing
// braces/brackets outside JSON string literals.
function unbalancedJSONTail(s) {
  let depth = 0, inString = false, escaped = false;
  for (const r of s) {
    if (escaped) escaped = false;
    else if (inString) {
      if (r === '\\') escaped = true;
      else if (r === '"') inString = false;
    } else if (r === '"') inString = true;
    else if (r === '{' || r === '[') depth++;
    else if (r === '}' || r === ']') {
      depth--;
      if (depth < 0) depth = 0; // a superfluous closer in prose must not mask an open tail
    }
  }
  return depth > 0;
}

// lastNonSpace returns the final non-space char of s, '' for empty.
function lastNonSpace(s) {
  const trimmed = s.replace(/[ \t\n\r]+$/, '');
  return trimmed.slice(-1);
}

export function retryMessageTruncated(snippet) {
  return 'Your previous tool-call output was truncated mid-envelope. Re-emit the COMPLETE tool call protocol block only, with no extra commentary. Your previous output was:\n\n' + snippetTail(snippet);
}

export function retryMessageParseFailed(snippet) {
  return 'Your previous tool-call output could not be parsed. Re-emit a valid tool call protocol block for the listed tools only. Your previous output was:\n\n' + snippetTail(snippet);
}

// retryMessageUndeclared re-anchors the model to the declared tool list. The
// hallucinated block is NOT embedded (same reasoning as the refusal retry):
// replaying it would show the model its own invented tool as conversation
// fact.
export function retryMessageUndeclared() {
  return 'Your previous answer contained a tool call for a tool that does not exist. Use ONLY the tools listed in the tool operations above — never invent an operation name. Re-emit the COMPLETE tool call block using one of the listed tools, or answer normally if none applies.';
}

// classifyRefusal recognizes the canned refusal shapes (recovery.go
// ClassifyRefusal): "I'm Mercury, built by Inception. I'm not able to get
// into the details..." and the capability-denial phrasings. Greedy beats
// blind here — refusing to detect the real shape costs the user a canned
// refusal.
export function classifyRefusal(text) {
  const lower = text.toLowerCase();
  if (lower.includes('not able to get into the details') || lower.includes("i'm mercury")) return true;
  if (lower.includes('i cannot') && (lower.includes('access') || lower.includes('browse') || lower.includes('search') || lower.includes('web'))) return true;
  if (lower.includes('unable to access') || lower.includes("i can't browse") || lower.includes("i can't access the web")) return true;
  const re = "i don't have ";
  const idx = lower.indexOf(re);
  if (idx >= 0) {
    let rest = lower.slice(idx + re.length);
    if (rest.startsWith('the ')) rest = rest.slice(4);
    if (rest.startsWith('ability') || rest.startsWith('access')) return true;
  }
  if (lower.includes('no internet access') || lower.includes('no web access')) return true;
  for (const sig of ['无法访问互联网', '不能联网', '没有联网', '无法联网']) {
    if (text.includes(sig)) return true;
  }
  return false;
}

// SWITCH_NOTE_PATTERN matches the model-switch note hermes-style clients
// prepend to the user turn ("[Note: model was just switched from X to Y via
// Z. ...]") — the measured trigger of the canned identity refusal.
const SWITCH_NOTE_PATTERN = /^\s*\[Note:[^\]]*\]\s*/s;

// stripSwitchNote removes a leading model-switch note from a user text so a
// refusal retry never re-injects the identity instruction that caused it.
export function stripSwitchNote(s) {
  return s.trim().replace(SWITCH_NOTE_PATTERN, '');
}

// retryMessageRefusal builds the retry turn for a refused round. The refused
// content is NOT embedded: the refusal is a canned shape the model must drop,
// not an output it must repair — replaying it would only reinforce the
// refusal pattern the retry exists to break.
export function retryMessageRefusal() {
  return 'Your previous answer was a refusal, but the tools in this conversation are real and connected. Do not ask the user to search manually and do not describe limitations. Re-emit the COMPLETE tool call block for the request, or run the tool call now and answer from its result.';
}

// snippetTail clamps the embedded original output to its last
// RETRY_SNIPPET_LIMIT chars, cut at a line boundary when possible.
function snippetTail(s) {
  if (s.length <= RETRY_SNIPPET_LIMIT) return s;
  let tail = s.slice(-RETRY_SNIPPET_LIMIT);
  const nl = tail.indexOf('\n');
  if (nl >= 0 && nl < tail.length / 2) tail = tail.slice(nl + 1);
  return tail;
}

function count(s, sub) {
  let n = 0, i = 0;
  for (;;) {
    i = s.indexOf(sub, i);
    if (i < 0) return n;
    n++;
    i += sub.length;
  }
}
