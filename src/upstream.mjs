// Upstream request path for chat.inceptionlabs.ai. Port of
// app/internal/upstream/client.go + reader.go + events.go.
//
// One request path: session fetches and chat both go through send(), so no
// endpoint can bypass the clearance cookie or grow its own retry loop.

import { Clearance, ClearanceError, UserAgent, isChallenge, BASE } from "./clearance.mjs";
import { TokenPool, validateToken } from "./session-pool.mjs";
import { pumpLines, STOP, DEFAULT_IDLE_MS, IdleTimeoutError } from "./lines.mjs";

export { BASE, UserAgent };
export { validateToken };
// The idle watchdog is the shared line pump's, re-exported so chat's error
// mapper keeps one import for every upstream error type.
export { IdleTimeoutError };

const SESSION_TIMEOUT = 15_000; // bounds one /api/session fetch
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
// readSSE splits an upstream SSE body into parsed events, invoking onEvent
// per event. The watchdog and the byte buffer belong to the shared line pump
// (lines.mjs); this function is only the SSE reading of a line. Resolves when
// [DONE] arrives; rejects StreamTruncatedError when the body ends cleanly
// before [DONE] — a truncated answer must be distinguishable from a finished
// one. Malformed lines are skipped via onMalformed, never fatal.
export async function readSSE(body, onEvent, { signal, idleMs = DEFAULT_IDLE_MS, onMalformed } = {}) {
  const outcome = await pumpLines(body, (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") return STOP;
    const ev = parseEvent(payload);
    if (!ev) { onMalformed?.(payload); return; }
    onEvent(ev);
  }, { signal, idleMs });
  if (outcome !== "stopped") throw new StreamTruncatedError();
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
    // One opportunistic warmup solve at load; no background loop (owner
    // ruling — refills are demand-driven, never a self-imposed timer).
    this.clearance.topUp();
  }

  // clearanceStatus exposes Clearance.status() for magpie's usage hook.
  clearanceStatus() {
    return this.clearance.status();
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

  // send performs one request with clearance handling. On a challenge it
  // retires the cookie that carried it and replays — first on the next live
  // cookie if the ring has one, otherwise on a forced fresh solve; the forced
  // solve is the difference between a 120 ms PoW and a 503, because the edge
  // challenges by egress and the spare cookie is challenged too. A plain 429
  // (rate limit) retires the slot and passes through; the ring rotation is
  // the recovery. No backoff: a second challenge fails fast, magpie's own
  // fallback machinery rests the account, and the next request retries.
  async send(method, path, body, opts = {}) {
    await this.clearance.ensure();
    let { resp, cookie } = await this.do(method, path, body, opts);
    if (resp.status === 429 && !isChallenge(resp)) {
      this.clearance.retire(cookie);
      return resp;
    }
    if (!isChallenge(resp)) return resp;
    await resp.body?.cancel();
    this.clearance.noteChallenge();
    this.clearance.retire(cookie);
    if (this.clearance.liveCount() === 0) await this.clearance.ensure();
    ({ resp, cookie } = await this.do(method, path, body, opts));
    if (isChallenge(resp)) {
      // The spare was challenged too: the egress itself is being challenged.
      // Force one fresh solve (bypassing the probe cache — "unchallenged"
      // was just falsified) and replay a final time.
      await resp.body?.cancel();
      this.clearance.retire(cookie);
      try {
        await this.clearance.forceAcquire();
      } catch { /* fall through to the final attempt; it will fail anyway */ }
      ({ resp, cookie } = await this.do(method, path, body, opts));
      if (isChallenge(resp)) {
        // Fresh cookie, still challenged: this is the punitive window.
        // Fail fast; the next request retries when the edge relents.
        await resp.body?.cancel();
        this.clearance.noteChallenge();
        this.clearance.retire(cookie);
        this.clearance.stampFailure(new ClearanceError(`fresh cookie challenged on ${path}`));
        throw new ClearanceError(`the checkpoint challenged ${path} even after a fresh clearance`);
      }
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

  // search POSTs /api/search-lab/run and returns the NDJSON Response for the
  // caller to collect. The retry budget is the plain 401/403 token rotation: a
  // rejected token is discarded and the identical request replayed at most
  // MAX_AUTH_RETRIES times. chat() keeps its own loop only because its
  // too-long switch needs the token's identity; search has no such switch, so
  // the two never share a body. Every other non-200 throws a typed
  // UpstreamError carrying the numeric status magpie reads as a refusal (429
  // especially, with Retry-After attached) — search-lab has no
  // "conversation too long" and no login state to invalidate.
  async search(ureq, { signal } = {}) {
    const body = JSON.stringify(ureq);
    for (let attempt = 0; ; attempt++) {
      const token = await this.pool.get();
      const resp = await this.send("POST", "/api/search-lab/run", body, {
        signal,
        extraHeaders: {
          "x-session-token": token,
          accept: "application/x-ndjson",
          // Node/Bun decode brotli themselves, but asking for identity keeps
          // the body plain for every layer in between (the Go gateway does the
          // same because it cannot decode br at all).
          "accept-encoding": "identity",
        },
      });
      if (resp.status === 200) return resp;

      const errBody = await resp.text().catch(() => "");
      const err = new UpstreamError(resp.status, errBody.slice(0, 4096));
      const retryAfter = resp.headers.get("retry-after");
      if (retryAfter) err.retryAfter = retryAfter;
      if (resp.status !== 401 && resp.status !== 403) throw err;
      this.pool.discard(token);
      this.pool.replenish();
      if (attempt >= MAX_AUTH_RETRIES) throw err;
    }
  }
}
