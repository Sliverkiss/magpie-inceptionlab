// handleChat: the one entry the loader's fetch drives. Decodes the OpenAI
// chat-completions request, converts and talks upstream, and answers with an
// OpenAI-shaped JSON or SSE response.
//
// Port of app/internal/server/{chat.go,tools_chat.go}:
//  - plain path (no tools): delayed header commit — nothing is written until
//    the first visible text; a stream that ends with zero visible text is a
//    real HTTP 502, not a 200 with an empty SSE body.
//  - tools path: each round is consumed FULLY before any byte leaves, so a
//    zero-call round can be classified (clean / empty / truncated /
//    parse-failed / refused) and retried once before the client sees anything.

import {
  UpstreamError,
  eventContent, eventReasoning,
  StreamTruncatedError, IdleTimeoutError,
} from "./upstream.mjs";
import { ClearanceError, RefusedError } from "./clearance.mjs";
import { decodeBody, normalizeHistory, buildChatRequest, buildToolChatRequest, RequestError } from "./convert.mjs";
import { foldHistory, HISTORY_FORMAT_SECTION } from "./history-fold.mjs";
import { buildManifest } from "./tools-manifest.mjs";
import { Parser } from "./tools-parse.mjs";
import {
  classifyNoCall, retryMessageTruncated, retryMessageParseFailed,
  retryMessageRefusal, retryMessageUndeclared, stripSwitchNote,
  RECOVERY_TRUNCATED, RECOVERY_PARSE_FAILED, RECOVERY_REFUSED, RECOVERY_UNDECLARED,
} from "./tools-recovery.mjs";
import { newCallId } from "./tools-replay.mjs";
import { randomId } from "./convert.mjs";

let client = null;

// TEXT_ONLY: the upstream web client accepts no image/audio parts; every
// model in the catalog is text-in, text-out.
export const TEXT_ONLY = { text: true, image: false, audio: false, video: false, pdf: false };

// setClient binds the process-wide upstream handle (called from index.mjs).
export function setClient(c) { client = c; }

// handleChat answers one POST {baseURL}/chat/completions. body is the decoded
// JSON string (or byte value) magpie forwarded; modelMap routes ids. Returns
// a Response.
export async function handleChat({ body, modelMap, signal }) {
  let req;
  try {
    req = decodeBody(body);
  } catch (e) {
    if (e instanceof RequestError) return errorResponse(e.status, e.message, e.type, e.code, e.param);
    throw e;
  }
  const route = modelMap.get(req.model) ?? modelMap.get("mercury-3");
  if (!route) {
    return errorResponse(404, `model ${req.model} not found`, "invalid_request_error", "model_not_found", "model");
  }

  try {
    if (req.toolChoice.kind === "none" || req.tools.length === 0) {
      return await plainChat(req, signal);
    }
    return await toolsChat(req, signal);
  } catch (err) {
    return errorResponse(...mapUpstreamError(err));
  }
}

// ---------------------------------------------------------------- plain path

async function plainChat(req, signal) {
  const hist = normalizeHistory(req.messages).map((h) =>
    // A role:"tool" entry in a tools-less request rides as its result text:
    // the plain converter reads {role, texts} only.
    (h.results?.length ?? 0) > 0
      ? { role: "user", texts: h.results.map((r) => r.content) }
      : h,
  );
  const ureq = buildChatRequest(hist, req.effort);
  if (!req.stream) return completeFromStream(ureq, req.model, signal);
  // client.chat is async: the promise must resolve before iterating.
  return plainStreamResponse(await client.chat(ureq, { signal }), req.model, estimateRequestTokens(ureq));
}

// channel is a tiny push/pull adapter: a producer pump feeds frames, the
// reader drains them; errors surface on read.
function channel() {
  const queue = [];
  let wake = null;
  let err = null;
  let ended = false;
  const step = () => wake?.();
  return {
    push(v) { queue.push(v); step(); },
    fail(e) { err = e; ended = true; step(); },
    end() { ended = true; step(); },
    async *reader() {
      while (true) {
        if (queue.length) { yield queue.shift(); continue; }
        if (ended) { if (err) throw err; return; }
        await new Promise((r) => { wake = r; });
      }
    },
  };
}

// plainStreamResponse implements the DELAYED header commit (chat.go): the
// role frame and every reasoning delta seen before the first visible text are
// buffered in memory; the Response is only constructed once text arrives. An
// empty completion — or any failure before text — throws here, so the client
// gets a real HTTP error status instead of a 200 with an empty SSE body. A
// mid-stream failure after text rides the in-stream error frame.
async function plainStreamResponse(it, model, promptTokens = 0) {
  const ch = channel();
  const id = randomId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  let completionChars = 0;
  const push = (delta, finish, usage) => {
    ch.push(`data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      ...(usage ? { usage } : {}),
    })}\n\n`);
  };

  const buffered = [];
  const cites = [];
  const citeIndex = new Map();
  let sawText = false;
  let ready;
  const readyPromise = new Promise((res) => { ready = res; });

  (async () => {
    try {
      for await (const ev of it) {
        observeCitation(ev, cites, citeIndex);
        const reasoning = eventReasoning(ev);
        const text = eventContent(ev);
        if (text && !sawText) {
          sawText = true;
          push({ role: "assistant" });
          for (const b of buffered) {
            completionChars += countChars(b);
            push({ reasoning_content: b });
          }
          buffered.length = 0;
          ready({ ok: true });
        }
        if (reasoning) {
          if (sawText) {
            completionChars += countChars(reasoning);
            push({ reasoning_content: reasoning });
          } else buffered.push(reasoning);
        }
        if (text) {
          completionChars += countChars(text);
          push({ content: text });
        }
      }
      if (!sawText) {
        ready({ ok: false, error: new EmptyCompletionError() });
        return;
      }
      const usage = usageOf(promptTokens, tokensOf(completionChars));
      push({ annotations: cites.length ? cites : undefined }, "stop", usage);
      ch.push("data: [DONE]\n\n");
      ch.end();
    } catch (e) {
      if (!sawText) { ready({ ok: false, error: e }); return; }
      const [status, message, type, code] = mapUpstreamError(e);
      ch.push(`data: ${JSON.stringify({ error: { message, type, code } })}\n\n`);
      ch.push("data: [DONE]\n\n");
      ch.end();
    }
  })();

  const gate = await readyPromise;
  if (!gate.ok) throw gate.error;
  return new Response(ch.reader(), {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

// EmptyCompletionError → 502 with the upstream_empty code.
class EmptyCompletionError extends Error {
  constructor(cause) { super("upstream returned an empty response"); this.cause = cause; this.empty = true; }
}

// ---------------------------------------------------------------- tools path

async function toolsChat(req, signal) {
  let hist = normalizeHistory(req.messages);
  const list = req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  // decodeBody's {kind, name} → buildManifest's {auto, required, named}.
  const k = req.toolChoice.kind;
  const choice = { auto: k === "auto", required: k === "required", named: k === "named" ? req.toolChoice.name : "" };
  const manifest = buildManifest(list, choice, req.parallelOff);
  const fold = foldHistory(hist, true);
  hist = fold.hist;
  let preamble = manifest.preamble;
  if (fold.folded) preamble += "\n\n" + HISTORY_FORMAT_SECTION + "\n";
  const fullManifest = { ...manifest, preamble };

  const readRound = async (ureq) => {
    const it = await client.chat(ureq, { signal });
    let content = "", reasoning = "";
    const cites = [];
    const citeIndex = new Map();
    const parser = new Parser(fullManifest.declared);
    for await (const ev of it) {
      observeCitation(ev, cites, citeIndex);
      reasoning += eventReasoning(ev);
      content += parser.feed(eventContent(ev));
    }
    content += parser.flush();
    return { content, reasoning, calls: parser.calls, cites };
  };

  const build = (h) => buildToolChatRequest(h, req.effort, fullManifest);
  let ureq = build(hist);
  let res = await readRound(ureq);

  const empty = () => res.content === "" && res.calls.length === 0;
  const kindOf = () => {
    if (res.calls.length > 0) return null;
    if (empty()) return "empty";
    const kind = classifyNoCall(res.content, fullManifest.declared);
    return kind === "clean" ? null : kind; // clean prose is a legal terminal
  };

  let kind = kindOf();
  if (kind) {
    // One bounded retry; whatever it returns is passed through verbatim.
    const retryReq = retryRequestFor(ureq, res, kind);
    try {
      res = await readRound(retryReq);
      ureq = retryReq; // usage is computed against the request that answered
    } catch {
      // original round passes through verbatim
    }
  }
  if (empty()) throw new EmptyCompletionError();

  const usage = usageOf(estimateRequestTokens(ureq), estimateCompletionTokens(res));
  return respondRound(res, req.model, req.stream, usage);
}

// retryRequestFor builds the upstream request a recovery retry re-asks with:
// the empty answer keeps the same request; broken-call kinds append the
// original output as an assistant turn plus the retry message; the refusal
// re-instruction also scrubs model-switch notes from historical user turns.
function retryRequestFor(ureq, res, kind) {
  if (kind === "empty") return ureq;
  let message;
  if (kind === RECOVERY_TRUNCATED) message = retryMessageTruncated(res.content);
  else if (kind === RECOVERY_PARSE_FAILED) message = retryMessageParseFailed(res.content);
  else if (kind === RECOVERY_UNDECLARED) message = retryMessageUndeclared();
  else if (kind === RECOVERY_REFUSED) message = retryMessageRefusal();
  else return ureq;

  const msgs = [...ureq.messages];
  if (kind === RECOVERY_REFUSED) {
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role !== "user") continue;
      const parts = m.parts.map((p) => (p.type === "text" ? { ...p, text: stripSwitchNote(p.text) } : p));
      msgs[i] = { ...m, parts };
    }
  }
  // Refused and undeclared rounds are canned/hallucinated shapes the model
  // must drop, not outputs it must repair — replaying them would only
  // reinforce the pattern the retry exists to break.
  if (res.content !== "" && kind !== RECOVERY_REFUSED && kind !== RECOVERY_UNDECLARED) {
    msgs.push({ parts: [{ type: "text", text: res.content, state: "done" }], id: randomId("m"), role: "assistant" });
  }
  msgs.push({ parts: [{ type: "text", text: message }], id: randomId("m"), role: "user" });
  return { ...ureq, messages: msgs, id: randomId("c") };
}

// respondRound writes an already-consumed round: JSON completion or SSE
// replay (role frame, reasoning, content, tool_calls deltas, finish with
// annotations, [DONE]). finish_reason is tool_calls when calls remain.
async function respondRound(res, model, stream, usage) {
  if (!stream) {
    return new Response(JSON.stringify({
      id: randomId("chatcmpl"),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: res.content,
          ...(res.reasoning ? { reasoning_content: res.reasoning } : {}),
          ...(res.cites.length ? { annotations: res.cites } : {}),
          ...(res.calls.length ? { tool_calls: res.calls.map((c) => ({ id: newCallId(), type: "function", function: { name: c.name, arguments: c.arguments } })) } : {}),
        },
        finish_reason: res.calls.length ? "tool_calls" : "stop",
      }],
      usage,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  const id = randomId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const push = (delta, finish, u) => `data: ${JSON.stringify({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    ...(u ? { usage: u } : {}),
  })}\n\n`;

  const frames = [];
  frames.push(push({ role: "assistant" }));
  if (res.reasoning) frames.push(push({ reasoning_content: res.reasoning }));
  if (res.content) frames.push(push({ content: res.content }));
  res.calls.forEach((c, i) => {
    frames.push(push({ tool_calls: [{ index: i, id: newCallId(), type: "function", function: { name: c.name, arguments: c.arguments } }] }));
  });
  const finish = res.calls.length ? "tool_calls" : "stop";
  frames.push(push({ annotations: res.cites.length ? res.cites : undefined }, finish, usage));
  frames.push("data: [DONE]\n\n");

  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

// ----------------------------------------------------- shared: non-stream

// completeFromStream aggregates the upstream stream into a single
// chat.completion (plain path). An empty completion is a 502.
async function completeFromStream(ureq, model, signal) {
  const it = await client.chat(ureq, { signal });
  let content = "", reasoning = "";
  const cites = [];
  const citeIndex = new Map();
  try {
    for await (const ev of it) {
      observeCitation(ev, cites, citeIndex);
      reasoning += eventReasoning(ev);
      content += eventContent(ev);
    }
  } catch (e) {
    if (e instanceof EmptyCompletionError) throw e;
    // The envelope must not swallow the cause: map it like every other path.
    throw e;
  }
  if (content === "") throw new EmptyCompletionError();
  const usage = usageOf(
    estimateRequestTokens(ureq),
    tokensOf(countChars(content) + countChars(reasoning)),
  );
  return new Response(JSON.stringify({
    id: randomId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(cites.length ? { annotations: cites } : {}),
      },
      finish_reason: "stop",
    }],
    usage,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

// ------------------------------------------------------------- usage estimate

// estimateUsage approximates OpenAI token accounting. Mercury emits no usage
// events, so — like every other reverse proxy for a usage-less upstream — we
// estimate: ~4 chars per token over Unicode code points (UTF-16 .length
// overcounts CJK ~2x). Good enough for magpie's quota display and per-key
// rate math; not a billing figure.
const CHARS_PER_TOKEN = 4;

// countChars counts Unicode code points (UTF-16 .length overcounts CJK ~2x).
function countChars(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n++;
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++; // surrogate pair = one code point
    }
  }
  return n;
}

const tokensOf = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

function estimateRequestTokens(ureq) {
  let chars = 0;
  for (const m of ureq.messages) {
    for (const p of m.parts ?? []) {
      if (typeof p.text === "string") chars += countChars(p.text);
    }
  }
  return tokensOf(chars);
}

function estimateCompletionTokens(res) {
  let chars = countChars(res.content) + countChars(res.reasoning);
  for (const c of res.calls ?? []) chars += countChars(c.arguments) + countChars(c.name);
  return tokensOf(chars);
}

function usageOf(promptTokens, completionTokens) {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

// observeCitation collects source-url events into OpenAI citation
// annotations, 1-indexed in first-seen order.
function observeCitation(ev, cites, index) {
  if (ev.type !== "source-url") return;
  const url = typeof ev.url === "string" ? ev.url : "";
  if (!url || index.has(url)) return;
  index.set(url, cites.length + 1);
  cites.push({
    type: "url_citation",
    url,
    title: typeof ev.title === "string" ? ev.title.slice(0, 512) : "",
    content: "",
    start_index: 0,
    end_index: 0,
  });
}

// ------------------------------------------------------------- error mapping

// mapUpstreamError is the one upstream → OpenAI envelope mapper (errors.go).
function mapUpstreamError(err) {
  if (err instanceof EmptyCompletionError) {
    return [502, err.message, "server_error", "upstream_empty", ""];
  }
  if (err instanceof RequestError) {
    return [err.status, err.message, err.type, err.code, err.param];
  }
  if (err instanceof IdleTimeoutError) {
    return [504, "upstream sent nothing for the idle window; the request was abandoned", "server_error", "upstream_idle", ""];
  }
  if (err instanceof StreamTruncatedError) {
    return [502, "upstream closed the stream before completion", "server_error", "upstream_stream", ""];
  }
  if (err instanceof RefusedError || err instanceof ClearanceError) {
    return [503, "the upstream bot checkpoint could not be cleared; retry shortly", "server_error", "upstream_clearance", ""];
  }
  if (err instanceof UpstreamError) {
    const msg = upstreamMessage(err) || `upstream returned HTTP ${err.status}`;
    // Rate limits and upstream 5xx pass through verbatim (HOOKS.md 七): the
    // gateway parses Retry-After from a 429 and treats 5xx differently from
    // a generic 502.
    const status = err.status === 429 || err.status >= 500 ? err.status : 502;
    return [status, msg, "server_error", "upstream_error", ""];
  }
  return [502, "upstream request failed", "server_error", "upstream_error", ""];
}

// upstreamMessage surfaces the upstream's own error text (minus HTML
// challenge pages and JSON envelope wrappers).
function upstreamMessage(err) {
  const body = (err.body ?? "").trim();
  if (!body || body.startsWith("<") || body.includes("<html")) return "";
  try {
    const env = JSON.parse(body);
    const nested = env?.error?.message;
    if (typeof nested === "string" && nested.trim()) return nested.trim().slice(0, 1000);
    if (typeof env?.error === "string" && env.error.trim()) return env.error.trim().slice(0, 1000);
    if (typeof env?.message === "string" && env.message.trim()) return env.message.trim().slice(0, 1000);
  } catch { /* prose body */ }
  return body.slice(0, 1000);
}

export function errorResponse(status, message, type = "server_error", code = "upstream_error", param = "") {
  return new Response(
    JSON.stringify({ error: { message, type, code, param: param || undefined } }),
    { status, headers: { "content-type": "application/json" } },
  );
}
