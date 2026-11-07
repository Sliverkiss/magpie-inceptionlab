// Search-lab client for chat.inceptionlabs.ai. Port of
// app/internal/upstream/{search.go,search_client.go,lines.go} and
// app/internal/server/search.go.
//
// POST /api/search-lab/run answers NDJSON (Accept: application/x-ndjson):
//   {t:"queries", queries:[...]}             rewritten queries
//   {t:"docs", sources:[{title,url,score}]}  ranked sources; no snippets exist
//   {t:"answer_delta", d:"..."}              synthesis, streamed
//   {t:"run_done", answer:"..."}             terminal — the grounded answer
//   {t:"error", message:"..."}               terminal
// call_start / rounds / candidates / answer_first_token are progress only: the
// answer phase follows them, so none of them ends the run.
//
// Terminal rules (measured 2026-10-22):
//   - run_done ends the run; its answer wins, and the accumulated deltas are
//     the fallback for an upstream that omits it.
//   - an error before docs fails the run; an error after docs is a failed
//     synthesis — retrieval already succeeded, so the sources are returned.
//   - a body that closes after docs is a complete retrieval whose answer is
//     whatever deltas arrived; one that closes before docs is truncation and
//     must never read as an empty result set.
//
// Content-Encoding: the request asks for identity (the Go gateway cannot
// decode brotli). Node/Bun's fetch decompresses gzip/br/deflate itself, so
// unlike the Go client there is no body decoder here — resp.body is already
// plain bytes.

import { UpstreamError } from "./upstream.mjs";
import { ClearanceError, RefusedError } from "./clearance.mjs";
import { pumpLines, STOP, DEFAULT_IDLE_MS } from "./lines.mjs";

const SEARCH_PATH = "/api/search-lab/run";

// Request defaults and the ranges /api/search-lab/config publishes. An
// out-of-range value is a translation (clamp), never a 400: the upstream
// owns its enums, and an invented rejection would be policy the caller never
// agreed to.
const DEFAULT_FANOUT = 3;
const MIN_FANOUT = 1;
const MAX_FANOUT = 5;
const DEFAULT_DEPTH = 1;
const MIN_DEPTH = 1;
const MAX_DEPTH = 3;
const DEFAULT_KEEP_TOP_K = 10;
const DEFAULT_EFFORT = "instant";
const TIMEZONE = "UTC";
const LANGUAGE = "en-US";

// Watchdog: the idle window slides on every received line; the absolute cap
// is ten of them, so an upstream emitting one keep-alive line per window
// cannot pin a request forever. The pump itself lives in lines.mjs, shared
// with the SSE family.
const ABSOLUTE_CAP_FACTOR = 10;

// Collection caps bound what a hostile or buggy upstream can make this module
// retain and echo. Well above any plausible run: the upstream's own maximum is
// fanout 5 x depth 3.
const MAX_QUERIES = 32;
const MAX_SOURCES = 50;
const MAX_QUERY_CHARS = 2000;
const MAX_ANSWER_BYTES = 1 << 20;
const MAX_TITLE_CHARS = 512;
const MAX_URL_CHARS = 4096;
const MAX_UPSTREAM_MESSAGE = 1000;

// SearchError is a terminal `{t:"error"}` event. The upstream message is kept
// for the caller's envelope and never re-sent to the upstream verbatim.
export class SearchError extends Error {
  constructor(message) {
    super(`upstream: search error: ${message}`);
    this.name = "SearchError";
    this.upstream = message;
  }
}

// SearchIncompleteError: the body ended before any docs event and without a
// terminal error. A closed stream is never reported as a successful search.
export class SearchIncompleteError extends Error {
  constructor() {
    super("upstream: search stream ended before docs");
    this.name = "SearchIncompleteError";
  }
}

// clampInt bounds v to [lo,hi], or returns def when v is unset (zero). It is
// the translation the upstream's published ranges ask for.
function clampInt(v, lo, hi, def) {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
  if (n === 0) return def;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

// keepTopK defaults an unset value and passes everything else through: the
// upstream publishes no range for it, so a local bound would be invented
// policy, not a translation.
function keepTopK(v) {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
  return n === 0 ? DEFAULT_KEEP_TOP_K : n;
}

// buildSearchRequest maps the caller's knobs onto the upstream wire shape.
export function buildSearchRequest(query, config = {}) {
  return {
    query,
    config: {
      fanout: clampInt(config?.fanout, MIN_FANOUT, MAX_FANOUT, DEFAULT_FANOUT),
      depth: clampInt(config?.depth, MIN_DEPTH, MAX_DEPTH, DEFAULT_DEPTH),
      keepTopK: keepTopK(config?.keepTopK),
      effort: typeof config?.effort === "string" && config.effort !== "" ? config.effort : DEFAULT_EFFORT,
    },
    timezone: TIMEZONE,
    language: LANGUAGE,
  };
}

// ---------------------------------------------------------------- source shape

// collapseSpace mirrors Go's strings.Join(strings.Fields(s), " ").
function collapseSpace(s) {
  return s.split(/\s+/u).filter(Boolean).join(" ");
}

function truncateChars(s, n) {
  const cps = [...s];
  return cps.length <= n ? s : cps.slice(0, n).join("");
}

function hasControl(s) {
  return /[\u0000-\u001f\u007f]/u.test(s);
}

// isHttpUrl reports whether raw is an absolute http(s) URL with a host. A
// non-http scheme is dropped rather than passed through: the documented
// consumer renders these as links, so javascript:/data: would be executable
// in its origin.
function isHttpUrl(raw) {
  const lower = raw.toLowerCase();
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) return false;
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host !== "";
  } catch {
    return false;
  }
}

function usableSource(url) {
  return isHttpUrl(url) && [...url].length <= MAX_URL_CHARS && !hasControl(url);
}

function sourceTitle(raw) {
  const s = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  return truncateChars(collapseSpace(s), MAX_TITLE_CHARS);
}

// normalizeSources cleans upstream titles (raw HTML whitespace), keeps only
// usable http(s) URLs, and bounds both length and count. The upstream already
// returns rank order, which is preserved.
export function normalizeSources(input) {
  const out = [];
  for (const s of Array.isArray(input) ? input : []) {
    if (out.length >= MAX_SOURCES) break;
    if (typeof s !== "object" || s === null) continue;
    const url = typeof s.url === "string" ? s.url.trim() : "";
    if (!usableSource(url)) continue;
    out.push({ title: sourceTitle(s.title), url, score: typeof s.score === "number" ? s.score : 0 });
  }
  return out;
}

// ------------------------------------------------------------------ collector

function collectQuery(state, raw) {
  if (state.queries.length >= MAX_QUERIES) return;
  if (typeof raw !== "string") return;
  const q = raw.trim();
  if (q === "" || [...q].length > MAX_QUERY_CHARS || state.seenQueries.has(q)) return;
  state.seenQueries.add(q);
  state.queries.push(q);
}

function collectDelta(state, d) {
  if (typeof d !== "string" || d === "") return;
  if (state.answerBytes >= MAX_ANSWER_BYTES) return;
  state.answerBytes += Buffer.byteLength(d, "utf8");
  state.deltas += d;
}

// feedLine applies one NDJSON line to the run state. Malformed lines and
// unknown event types are skipped, matching the /search playground's reader.
function feedLine(state, rawLine) {
  const line = rawLine.trim();
  if (line === "") return;
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (typeof ev !== "object" || ev === null) return;

  switch (ev.t) {
    case "queries":
      for (const q of Array.isArray(ev.queries) ? ev.queries : []) collectQuery(state, q);
      return;
    case "docs":
      state.sources = normalizeSources(ev.sources);
      state.haveDocs = true;
      return;
    case "answer_delta":
      collectDelta(state, ev.d);
      return;
    case "run_done":
      state.terminal = { kind: "done", answer: typeof ev.answer === "string" ? ev.answer : "" };
      return STOP;
    case "error":
      state.terminal = {
        kind: "error",
        message: (typeof ev.message === "string" ? ev.message : String(ev.message ?? "")).slice(0, MAX_UPSTREAM_MESSAGE),
      };
      return STOP;
    default:
      // run_start / call_start / call_end / candidates / round_start /
      // rounds / answer_first_token: progress, never terminators.
      return;
  }
}

// collectSearch consumes an NDJSON body into {queries, sources, answer}.
export async function collectSearch(body, { signal, idleMs = DEFAULT_IDLE_MS } = {}) {
  const state = { queries: [], seenQueries: new Set(), sources: [], deltas: "", answerBytes: 0, haveDocs: false, terminal: null };
  let failure = null;
  try {
    await pumpLines(body, (line) => feedLine(state, line), { signal, idleMs, capMs: idleMs * ABSOLUTE_CAP_FACTOR });
  } catch (e) {
    failure = e;
  }

  const { queries, sources, deltas, haveDocs, terminal } = state;
  if (terminal?.kind === "done") return { queries, sources, answer: terminal.answer || deltas };
  if (terminal?.kind === "error") {
    // Retrieval already succeeded: an error from the synthesis phase must not
    // discard it. The model keeps working from the sources without an answer.
    if (haveDocs) return { queries, sources, answer: "" };
    throw new SearchError(terminal.message);
  }
  // The body closed (or the watchdog fired) without a terminal event. Docs
  // already collected make that a complete retrieval; before docs it is
  // truncation and must not look like an empty result set.
  if (haveDocs) return { queries, sources, answer: deltas };
  if (failure) throw failure;
  throw new SearchIncompleteError();
}

// ------------------------------------------------------------------- execute

// searchInception runs one search-lab query and returns magpie pages:
// [{title, url, text, age}]. `count` is applied locally — the upstream has no
// count parameter, only fanout/depth — and bounds the documents.
//
// The run's grounded synthesis stops here, and that is a hard host ceiling, not
// a routing choice. magpie's `plugin.SearchPage` is
//
//	struct {
//	    Title   string      `json:"title"`
//	    URL     string      `json:"url"`
//	    PageAge interface{} `json:"page_age"`
//	}
//
// — three fields, no `text`. The host's JS `runSearch` maps
// `text: str(r.text ?? r.content ?? r.snippet)` onto a shape Go unmarshals into
// that struct, so the snippet is silently dropped crossing the plugin boundary.
// The same struct tags its age `page_age` while the JS sends `age`, so PageAge
// is nil for every page — a second, independent sign that nothing beyond
// title/url survives. There is no fourth channel to invent: smuggling the
// answer into `title` would be a page list lying about what it holds, and an
// empty-`url` summary entry is worse than nothing because `runSearch` does not
// drop it — it renders as a result that goes nowhere.
//
// So the answer is discarded at the boundary and the pages are the documents.
// collectSearch still returns it: that reading of the stream is correct and is
// what its tests pin, it just has nowhere to go.
export async function searchInception({ query, count } = {}, client, { signal, idleMs } = {}) {
  if (typeof query !== "string" || query.trim() === "") throw new Error("a search needs a query");
  if (!client || typeof client.search !== "function") throw new Error("a search needs an upstream client");

  let resp;
  try {
    resp = await client.search(buildSearchRequest(query.trim()), { signal });
  } catch (e) {
    // The edge checkpoint is the only login state this plugin has: a refusal
    // to clear it is a 503, so magpie rests the account like any other.
    if (e instanceof ClearanceError || e instanceof RefusedError) {
      throw new UpstreamError(503, `the upstream bot checkpoint could not be cleared: ${e.message}`);
    }
    throw e;
  }
  if (!resp.ok) {
    // client.search only returns 200; this is the belt-and-braces path for a
    // future upstream that answers 204/3xx without throwing.
    throw new UpstreamError(resp.status, `upstream: search-lab answered ${resp.status}`);
  }

  const { sources } = await collectSearch(resp.body, { signal, idleMs });
  const pages = sources.map((s) => ({ title: s.title, url: s.url, text: "", age: "" }));
  const want = Number.isInteger(count) && count > 0 ? Math.min(count, pages.length) : pages.length;
  return pages.slice(0, want);
}
