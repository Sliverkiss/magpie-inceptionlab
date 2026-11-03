// Wire markers and the streaming tool-call parser.
// Port of app/internal/tools/parse.go from inceptionlabs2api (Go).
//
// The primary format is the Hermes/Qwen <tool_call> marker block; the
// <tool_calls><invoke …> form is accepted as drift because the upstream model
// reproduces it verbatim. The parser is a pure state machine over the text
// received so far: feed() may be called with an arbitrary chunking, including
// splits inside a marker or a surrogate pair.

export const CALL_START = '<tool_call>';
export const CALL_END = '</tool_call>';
export const BLOCK_START = '<tool_calls>';
export const BLOCK_END = '</tool_calls>';
const INVOKE_OPEN = '<invoke name=';
const INVOKE_END = '</invoke>';
const PARAM_OPEN = '<parameter name=';
const PARAM_END = '</parameter>';

// Past this size a still-open block is emitted as prose, so a hostile stream
// cannot grow the buffer without limit.
const MAX_BLOCK_CHARS = 64 << 10;

export class Parser {
  constructor(declared = []) {
    this.declared = new Set(declared);
    this.buf = ''; // text not yet released
    this.open = ''; // marker that opened the current block, '' outside
    this.closer = '';
    this.calls = []; // {name, arguments} in appearance order
  }

  // feed() appends a chunk and returns the text now safe to emit.
  feed(chunk) {
    this.buf += chunk;
    return this.#drain(false);
  }

  // flush() ends the stream: everything still buffered is content. An open
  // block is shown verbatim (with its opening marker), never a call.
  flush() {
    let out = this.#drain(true);
    if (this.open) {
      out += this.open;
      this.open = this.closer = '';
    }
    out += this.buf;
    this.buf = '';
    return out;
  }

  #findStart() {
    const ci = this.buf.indexOf(CALL_START);
    const bi = this.buf.indexOf(BLOCK_START);
    if (ci < 0 && bi < 0) return -1;
    if (bi < 0 || (ci >= 0 && ci < bi)) return ci; // marker is CALL_START here
    return bi;
  }

  #drain(final) {
    let out = '';
    for (;;) {
      if (!this.open) {
        const idx = this.#findStart();
        if (idx < 0) {
          let cut = this.buf.length;
          if (!final) {
            cut -= holdback(this.buf);
            cut = surrogateFloor(this.buf, cut);
          }
          out += this.buf.slice(0, cut);
          this.buf = this.buf.slice(cut);
          return out;
        }
        const marker = this.buf.startsWith(BLOCK_START, idx) ? BLOCK_START : CALL_START;
        out += this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + marker.length);
        this.open = marker;
        this.closer = marker === BLOCK_START ? BLOCK_END : CALL_END;
        continue;
      }

      if (this.buf.length > MAX_BLOCK_CHARS) {
        out += this.open + this.buf;
        this.buf = '';
        this.open = this.closer = '';
        return out;
      }

      const end = this.buf.indexOf(this.closer);
      if (end < 0) {
        if (final) {
          out += this.open + this.buf;
          this.buf = '';
          this.open = this.closer = '';
        }
        return out;
      }

      const body = this.buf.slice(0, end);
      const rest = this.buf.slice(end + this.closer.length);
      const opened = this.open, closed = this.closer;
      this.open = this.closer = '';
      this.buf = rest;

      const call = opened === BLOCK_START
        ? this.#parseInvokeBlock(body)
        : this.#parseJSONCall(body);
      if (call) this.calls.push(call);
      else out += opened + body + closed;
    }
  }

  // <tool_call>{...}</tool_call>
  #parseJSONCall(body) {
    body = trimFence(body.trim());
    let raw;
    try {
      raw = JSON.parse(body);
    } catch {
      return null;
    }
    if (typeof raw !== 'object' || raw === null || typeof raw.name !== 'string') return null;
    if (!this.declares(raw.name)) return null;
    const args = objectJSON(raw.arguments);
    if (args === null) return null;
    return { name: raw.name, arguments: args };
  }

  // <tool_calls><invoke name="X">…</invoke></tool_calls>. Only the first
  // invoke becomes a call; the caller sees the rest as prose.
  #parseInvokeBlock(body) {
    const parsed = parseInvoke(body);
    if (!parsed || !this.declares(parsed.name)) return null;
    return parsed;
  }

  declares(name) {
    return name !== '' && this.declared.has(name);
  }
}

// parseInvoke parses the first <invoke> in s into {name, arguments}, where
// arguments is a JSON object of string-valued parameters.
function parseInvoke(s) {
  const i = s.indexOf(INVOKE_OPEN);
  if (i < 0) return null;
  s = s.slice(i + INVOKE_OPEN.length);
  const attr = attrValue(s);
  if (!attr) return null;
  const [name, rest0] = attr;
  let rest = rest0;
  const j = rest.indexOf(INVOKE_END);
  if (j >= 0) rest = rest.slice(0, j);
  // A self-closing <invoke name="x"/> carries no parameters.
  const k = rest.indexOf('>');
  if (k >= 0 && rest.slice(0, k).startsWith('/')) return { name, arguments: '{}' };

  const parts = [];
  for (;;) {
    const p = rest.indexOf(PARAM_OPEN);
    if (p < 0) break;
    rest = rest.slice(p + PARAM_OPEN.length);
    const keyAttr = attrValue(rest);
    if (!keyAttr) break;
    const [key, after] = keyAttr;
    rest = after;
    const v = rest.indexOf(PARAM_END);
    if (v < 0) break;
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(rest.slice(0, v))}`);
    rest = rest.slice(v + PARAM_END.length);
  }
  return { name, arguments: '{' + parts.join(',') + '}' };
}

// attrValue reads a quoted or unquoted attribute terminated by '>' and
// returns [value, textAfterGt], or null.
function attrValue(s) {
  if (s === '') return null;
  if (s[0] === '"' || s[0] === "'") {
    const q = s[0];
    const end = s.indexOf(q, 1);
    if (end < 0) return null;
    return [s.slice(1, end), s.slice(end + 2).replace(/^>/, '')];
  }
  const end = s.indexOf('>');
  if (end < 0) return null;
  return [s.slice(0, end).trim(), s.slice(end + 1)];
}

// objectJSON normalises an arguments value to a JSON object string.
// Returns null for any non-object shape (shown as prose, like Go).
function objectJSON(raw) {
  if (raw === undefined || raw === null) return '{}';
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  return JSON.stringify(raw);
}

// trimFence unwraps a single Markdown code fence around body.
function trimFence(s) {
  if (!s.startsWith('```')) return s;
  const nl = s.indexOf('\n');
  if (nl < 0) return s;
  s = s.slice(nl + 1).trim();
  if (s.endsWith('```')) s = s.slice(0, -3).trim();
  return s;
}

// holdback: trailing chars that are a prefix of either start marker (never the
// whole marker: a complete marker is found above).
function holdback(buf) {
  let best = 0;
  for (const m of [CALL_START, BLOCK_START]) {
    const max = Math.min(m.length - 1, buf.length);
    for (let k = max; k > best; k--) {
      if (buf.endsWith(m.slice(0, k))) {
        best = k;
        break;
      }
    }
  }
  return best;
}

// surrogateFloor moves cut back so buf.slice(0, cut) never splits a surrogate
// pair (the JS analogue of Go's runeFloor).
function surrogateFloor(buf, cut) {
  if (cut > 0 && cut < buf.length) {
    const c = buf.charCodeAt(cut);
    if (c >= 0xdc00 && c <= 0xdfff) cut--; // low surrogate: previous char is the high half
  }
  return cut;
}
