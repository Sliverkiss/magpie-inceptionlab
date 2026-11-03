// Upstream request path for chat.inceptionlabs.ai. Port of
// app/internal/upstream/client.go + reader.go + events.go.
//
// One request path: session fetches and chat both go through send(), so no
// endpoint can bypass the clearance cookie or grow its own retry loop.

import { Clearance, ClearanceError, UserAgent, isChallenge, BASE } from "./clearance.mjs";
import { TokenPool, validateToken } from "./session-pool.mjs";

export { BASE, UserAgent };
export { validateToken };

const SESSION_TIMEOUT = 15_000; // bounds one /api/session fetch
const IDLE_TIMEOUT = 60_000; // no SSE line for this long (sliding)
const MAX_AUTH_RETRIES = 2; // fresh-token attempts after a 401/403
const MAX_UPSTREAM_MESSAGES = 100; // upstream hard cap; below it "too long" is session accumulation
const TOO_LONG_MARKER = "conversation is too long";

// UpstreamError carries an upstream status + body for client-facing envelopes.
export class UpstreamError extends Error {
  constructor(status, body) {
    super(`upstream: status ${status}: ${String(body ?? "").slice(0, 200)}`);
    this.name = "UpstreamError";
    this.status = status;
    this.body = String(body ?? "");
  }
}

// isTooLong reports whether the upstream rejected the conversation length.
export function isTooLong(err) {
  return err?.body ? err.body.toLowerCase().includes(TOO_LONG_MARKER) : false;
}

// Event helpers over one parsed `data:` payload (x-vercel-ai-ui-message-stream
// v1). text-start may carry a whole-snapshot `text`; only reasoning-delta and
// text-delta carry `delta`.
export function parseEvent(payload) {
  let ev;
  try { ev = JSON.parse(payload); } catch { return null; }
  if (typeof ev !== "object" || ev === null || typeof ev.type !== "string") return null;
  return ev;
}

export function eventContent(ev) {
  if (ev.type === "text-start") return ev.text ?? "";
  if (ev.type === "text-delta") return ev.delta ?? "";
  return "";
}

export function eventReasoning(ev) {
  return ev.type === "reasoning-delta" ? ev.delta ?? "" : "";
}

export class StreamTruncatedError extends Error {
  constructor() { super("upstream: stream ended before [DONE]"); this.name = "StreamTruncatedError"; }
}
export class IdleTimeoutError extends Error {
  constructor() { super("upstream: stream idle timeout"); this.name = "IdleTimeoutError"; }
}

// readSSE splits an upstream SSE body into parsed events, invoking onEvent
// per event, with a sliding idle watchdog (every line, blank separators
// included, resets it). Resolves when [DONE] arrives; rejects
// StreamTruncatedError when the body ends cleanly before [DONE] — a truncated
// answer must be distinguishable from a finished one. Malformed lines are
// skipped via onMalformed, never fatal.
export async function readSSE(body, onEvent, { signal, idleMs = IDLE_TIMEOUT, onMalformed } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const onLine = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") return "stop";
    const ev = parseEvent(payload);
    if (!ev) { onMalformed?.(payload); return; }
    onEvent(ev);
  };

  let idleTimer = null;
  let idleReject = null;
  const idlePromise = new Promise((_, rej) => { idleReject = rej; });
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idleReject(new IdleTimeoutError()), idleMs);
  };
  idlePromise.catch(() => {}); // no unhandled rejection when the pump wins
  armIdle();

  try {
    while (true) {
      const { value, done: eof } = await Promise.race([reader.read(), idlePromise]);
      if (eof) break;
      armIdle();
      buf += decoder.decode(value, { stream: true });
      let idx;
      let stop = false;
      while ((idx = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (onLine(line) === "stop") { stop = true; break; }
      }
      if (stop) return;
    }
    const tail = (buf + decoder.decode()).trim();
    if (tail && onLine(tail) !== "stop") throw new StreamTruncatedError();
    if (!tail) throw new StreamTruncatedError();
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    try { await reader.cancel(); } catch {}
  }
}

// streamEvents wraps readSSE as an async iterator of events. The consumer
// drives the read loop; aborting is the caller's signal.
export async function* streamEvents(body, opts = {}) {
  const queue = [];
  let wake = null;
  let err = null;
  let ended = false;
  const step = () => { wake?.(); };
  readSSE(body, (ev) => { queue.push(ev); step(); }, {
    ...opts,
    onMalformed: (l) => { opts.onMalformed?.(l); },
  }).then(() => { ended = true; step(); }, (e) => { err = e; ended = true; step(); });
  while (true) {
    if (queue.length) { yield queue.shift(); continue; }
    if (ended) { if (err) throw err; return; }
    await new Promise((res) => { wake = res; });
  }
}

// Client is the one upstream handle: clearance + token pool + the shared
// request path with challenge replay and token retry.
export class Client {
  constructor({ fetchImpl = fetch, clearanceSize = 2, poolMin = 1, poolMax = 2 } = {}) {
    this.fetchImpl = fetchImpl;
    this.clearance = new Clearance({ size: clearanceSize, fetchImpl });
    this.pool = new TokenPool({
      min: poolMin,
      max: poolMax,
      fetchToken: () => this.fetchSession(),
    });
    // Request-driven warmup: no background loop against the edge. The first
    // chat solves inline via ensure(); each successful request tops the ring
    // up by one slot (retire() and expiry also call it).
    this.clearance.topUp();
  }

  // fetchSession calls GET /api/session once through the clearance path and
  // validates the token shape.
  async fetchSession() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SESSION_TIMEOUT);
    try {
      const resp = await this.send("GET", "/api/session", null, { signal: ctrl.signal, extraHeaders: { accept: "*/*" } });
      const body = await resp.text();
      if (resp.status !== 200) throw new UpstreamError(resp.status, body);
      let payload;
      try { payload = JSON.parse(body); } catch {
        throw new Error(`upstream: parse session response (body ${body.slice(0, 200)})`);
      }
      if (payload?.ok !== true || typeof payload.token !== "string" || payload.token === "") {
        throw new Error(`upstream: session response ok=${payload?.ok} token present=${!!payload?.token}`);
      }
      if (!validateToken(payload.token)) {
        throw new Error(`upstream: malformed session token ${payload.token.slice(0, 16)}`);
      }
      // The clearance works: opportunistically fill the next ring slot so a
      // future challenge replays instead of solving inline.
      this.clearance.topUp();
      return payload.token;
    } finally {
      clearTimeout(timer);
    }
  }

  // do issues one request. No wall-clock cap: a cap would kill legitimately
  // long diffusion generations; the idle watchdog lives in readSSE. Returns
  // the Response plus the cookie that rode it, so a challenge can retire
  // exactly that slot (fetch does not echo request cookies on the Response).
  async do(method, path, body, { signal, extraHeaders } = {}) {
    const { ua, cookie } = this.clearance.header();
    const headers = new Headers(extraHeaders);
    headers.set("user-agent", ua);
    if (cookie) headers.set("cookie", cookie);
    if (body !== null && body !== undefined) headers.set("content-type", "application/json");
    const resp = await this.fetchImpl(`${BASE}${path}`, {
      method,
      headers,
      body: body === null || body === undefined ? undefined : body,
      signal,
    });
    return { resp, cookie };
  }

  // send performs one request with clearance handling: on a challenge it
  // retires the cookie that carried it and replays ONCE on the next live
  // cookie; the request path never waits for a solve (ensure() only solves
  // inline when the ring has nothing live). A plain 429 (rate limit) retires
  // the slot and passes the 429 through — the ring rotation is the recovery.
  async send(method, path, body, opts = {}) {
    await this.clearance.ensure();
    let { resp, cookie } = await this.do(method, path, body, opts);
    if (resp.status === 429 && !isChallenge(resp)) {
      this.clearance.retire(cookie);
      return resp;
    }
    if (!isChallenge(resp)) return resp;
    await resp.body?.cancel();
    this.clearance.retire(cookie);
    await this.clearance.ensure();
    ({ resp } = await this.do(method, path, body, opts));
    if (isChallenge(resp)) {
      await resp.body?.cancel();
      throw new ClearanceError(`the checkpoint challenged ${path} even after a fresh clearance`);
    }
    return resp;
  }

  // chat POSTs /api/chat and returns an async iterator of parsed events.
  //
  // Retry budget: a 401/403 discards the token that carried it and retries
  // with a fresh one at most MAX_AUTH_RETRIES times; other non-200 statuses
  // throw a typed UpstreamError and keep the token. When the upstream answers
  // the "conversation is too long" rejection and the request carried at most
  // MAX_UPSTREAM_MESSAGES — so the rejection is session-accumulated, not ours
  // — the token is discarded and the IDENTICAL request replays once (the
  // lazy session switch, bounded). A replay that fails surfaces the ORIGINAL
  // error verbatim; a request over the cap is legitimately ours: plain
  // passthrough.
  async chat(ureq, { signal } = {}) {
    const body = JSON.stringify(ureq);
    const sendChat = async (token) => {
      const resp = await this.send("POST", "/api/chat", body, {
        signal,
        extraHeaders: { "x-session-token": token, accept: "text/event-stream, application/json" },
      });
      if (resp.status === 200) return resp;
      const errBody = await resp.text().catch(() => "");
      throw new UpstreamError(resp.status, errBody.slice(0, 4096));
    };

    let lastErr = null;
    let authRetries = 0;
    let tooLongRetries = 0;
    while (true) {
      const token = await this.pool.get();
      let resp;
      try {
        resp = await sendChat(token);
      } catch (e) {
        if (e instanceof UpstreamError && isTooLong(e) && ureq.messages.length <= MAX_UPSTREAM_MESSAGES && tooLongRetries < 1) {
          // Lazy session switch: retire exactly this token, replay once.
          this.pool.discard(token);
          this.pool.replenish();
          tooLongRetries++;
          lastErr = e;
          continue;
        }
        if (e instanceof UpstreamError && (e.status === 401 || e.status === 403) && authRetries < MAX_AUTH_RETRIES) {
          this.pool.discard(token);
          this.pool.replenish();
          authRetries++;
          lastErr = e;
          continue;
        }
        // Transport errors and exhausted retries: no token discard (the pool
        // never poisons a token for an upstream fault); surface as-is.
        throw e;
      }
      return streamEvents(resp.body, { signal });
    }
  }
}
