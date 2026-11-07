// Search-lab client tests. The fixture is the measured 2026-10-22 NDJSON
// capture shape (search_test.go fullRun): plan → queries → one retrieval
// round → rerank → docs → synthesis, ending at run_done.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "../src/upstream.mjs";
import { IdleTimeoutError, AbortError } from "../src/lines.mjs";
import {
  searchInception, collectSearch, buildSearchRequest, normalizeSources,
  SearchError, SearchIncompleteError,
} from "../src/search.mjs";

// fullRun is the captured run. An empty answer leaves the stream at the deltas
// (the synthesis phase never reached run_done); a non-empty one carries
// "partial" as the delta text so the run_done answer can be told apart.
function fullRun(answer = "") {
  const lines = [
    `{"t":"run_start","config":{"fanout":3,"depth":1}}`,
    `{"t":"call_start","id":"c43","kind":"plan","llm":true}`,
    `{"t":"call_end","id":"c43","outputTokens":35,"inputTokens":537}`,
    `{"t":"queries","queries":["go 1.27 release date","go 1.27 new features"]}`,
    `{"t":"round_start","run":1,"of":1}`,
    `{"t":"call_start","id":"c50","kind":"retrieve"}`,
    `{"t":"call_end","id":"c50"}`,
    `{"t":"candidates","count":7,"fresh":7}`,
    `{"t":"call_start","id":"c52","kind":"rerank","llm":true}`,
    `{"t":"call_end","id":"c52","inputTokens":1281}`,
    `{"t":"docs","retrieved":7,"kept":2,"sources":[` +
      `{"title":"Go 1.27 Release Notes","url":"https://go.dev/doc/go1.27","score":0.97},` +
      `{"title":"The Go Blog: Go 1.27","url":"https://go.dev/blog/go1.27","score":0.91}]}`,
    `{"t":"rounds","run":1,"of":1,"stoppedEarly":false}`,
    `{"t":"call_start","id":"c54","kind":"synthesize","llm":true}`,
    `{"t":"answer_first_token","ms":2302}`,
  ];
  if (answer === "") {
    lines.push(`{"t":"answer_delta","d":"Go 1.27 was released on August 19, 2026 "}`);
    lines.push(`{"t":"answer_delta","d":"with the new trace-based testing [1][2]."}`);
  } else {
    lines.push(`{"t":"answer_delta","d":"partial"}`);
    lines.push(`{"t":"run_done","ms":2282,"answer":${JSON.stringify(answer)}}`);
  }
  lines.push(`{"t":"call_end","id":"c54","outputTokens":115,"inputTokens":1167}`);
  return lines.join("\n") + "\n";
}

const enc = new TextEncoder();

// bodyOf turns text (or explicit byte chunks) into a Response body stream.
function bodyOf(chunks) {
  const list = Array.isArray(chunks) ? chunks : [chunks];
  return new ReadableStream({
    start(c) {
      for (const ch of list) c.enqueue(typeof ch === "string" ? enc.encode(ch) : ch);
      c.close();
    },
  });
}

// hang is a body that never sends and never closes: the watchdog's test.
function hang() {
  return new ReadableStream({ start() { /* never enqueue, never close */ } });
}

const collect = (chunks, opts) => collectSearch(bodyOf(chunks), { idleMs: 5_000, ...opts });

// ------------------------------------------------------------- wire request

test("buildSearchRequest clamps fanout/depth and defaults the rest", () => {
  assert.deepEqual(buildSearchRequest("q"), {
    query: "q",
    config: { fanout: 3, depth: 1, keepTopK: 10, effort: "instant" },
    timezone: "UTC",
    language: "en-US",
  });
  const high = buildSearchRequest("q", { fanout: 99, depth: 99, keepTopK: 4, effort: "high" });
  assert.equal(high.config.fanout, 5);
  assert.equal(high.config.depth, 3);
  assert.equal(high.config.keepTopK, 4);
  assert.equal(high.config.effort, "high");
  const low = buildSearchRequest("q", { fanout: -1, depth: -1, effort: "" });
  assert.equal(low.config.fanout, 1);
  assert.equal(low.config.depth, 1);
  assert.equal(low.config.effort, "instant");
});

// ------------------------------------------------------------------ sources

test("normalizeSources drops non-http and control-bearing URLs", () => {
  const out = normalizeSources([
    { title: "ok", url: "https://example.com/a", score: 1 },
    { title: "js", url: "javascript:alert(1)" },
    { title: "data", url: "data:text/html,x" },
    { title: "no host", url: "https://" },
    { title: "ctrl", url: "https://example.com/\u0007" },
    { title: "not an object", url: 7 },
    null,
  ]);
  assert.deepEqual(out.map((s) => s.url), ["https://example.com/a"]);
});

test("normalizeSources collapses title whitespace and bounds the list", () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ title: `  t${i}\n\t x `, url: `https://e.com/${i}` }));
  const out = normalizeSources(many);
  assert.equal(out.length, 50);
  assert.equal(out[0].title, "t0 x");
});

// ---------------------------------------------------------------- collector

test("run_done answer wins over the accumulated deltas", async () => {
  const res = await collect(fullRun("Go 1.27 was released on August 19, 2026 [1][2][3]."));
  assert.equal(res.answer, "Go 1.27 was released on August 19, 2026 [1][2][3].");
  assert.equal(res.sources.length, 2);
  assert.deepEqual(res.queries, ["go 1.27 release date", "go 1.27 new features"]);
});

test("a body that closes after docs is a complete retrieval", async () => {
  const res = await collect(fullRun());
  assert.equal(res.sources.length, 2);
  assert.equal(res.answer, "Go 1.27 was released on August 19, 2026 with the new trace-based testing [1][2].");
});

test("run_done with an empty answer falls back to the deltas", async () => {
  const res = await collect(fullRun() + `{"t":"run_done","ms":2282,"answer":""}\n`);
  assert.equal(res.answer, "Go 1.27 was released on August 19, 2026 with the new trace-based testing [1][2].");
});

test("deltas concatenate byte-exactly across a split rune", async () => {
  const d1 = "Go 1.27 于 2026 年 8 月 19 日发布，";
  const d2 = "主要新特性是 trace-based testing [1][2][3]。";
  const text = fullRun() + `{"t":"run_done","answer":${JSON.stringify(d1 + d2)}}\n`;
  const bytes = enc.encode(text);
  // Split mid-rune: the decoder must stitch the surrogate-free UTF-8 back.
  const cut = bytes.indexOf(0xe4) + 1;
  const res = await collect([bytes.slice(0, cut), bytes.slice(cut)]);
  assert.equal(res.answer, d1 + d2);
});

test("a truncated stream before docs is incomplete, never an empty result", async () => {
  const body = `{"t":"run_start","config":{}}\n{"t":"queries","queries":["go"]}\n`;
  await assert.rejects(() => collect(body), SearchIncompleteError);
});

test("an error event before docs fails the run", async () => {
  const body = `{"t":"run_start","config":{}}\n{"t":"error","message":"retrieval unavailable"}\n`;
  await assert.rejects(() => collect(body), (e) => e instanceof SearchError && e.upstream === "retrieval unavailable");
});

test("an error event after docs keeps the retrieval", async () => {
  const res = await collect(fullRun() + `{"t":"error","message":"synthesis failed"}\n`);
  assert.equal(res.sources.length, 2);
  assert.equal(res.answer, "");
});

test("malformed lines and unknown events are skipped", async () => {
  const body = `not json\n{"t":"run_start"}\n` + fullRun("answer") + `{"t":"who_knows","x":1}\n`;
  const res = await collect(body);
  assert.equal(res.answer, "answer");
  assert.equal(res.sources.length, 2);
});

test("queries dedupe and stop at the retention cap", async () => {
  const many = Array.from({ length: 40 }, (_, i) => `"q${i}"`);
  const body = `{"t":"queries","queries":[${many.join(",")}]}\n` +
    `{"t":"queries","queries":["q0","q1"]}\n{"t":"docs","sources":[]}\n`;
  const res = await collect(body);
  assert.equal(res.queries.length, 32);
  assert.equal(res.queries[0], "q0");
});

test("an over-long query is dropped, not truncated", async () => {
  const long = "x".repeat(2001);
  const body = `{"t":"queries","queries":[${JSON.stringify(long)},"ok"]}\n{"t":"docs","sources":[]}\n`;
  const res = await collect(body);
  assert.deepEqual(res.queries, ["ok"]);
});

test("an idle stream trips the watchdog", async () => {
  await assert.rejects(() => collectSearch(hang(), { idleMs: 10 }), IdleTimeoutError);
});

test("a caller abort rejects without waiting the window", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(() => collectSearch(hang(), { signal: ctrl.signal, idleMs: 60_000 }), AbortError);
});

// ---------------------------------------------------------------- execute

const mockClient = (body, { status = 200 } = {}) => ({
  seen: [],
  async search(ureq) {
    this.seen.push(ureq);
    return new Response(body, { status });
  },
});

test("searchInception returns the documents, never the synthesis", async () => {
  const client = mockClient(fullRun("Go 1.27 shipped [1][2]."));
  const pages = await searchInception({ query: "  go 1.27  ", count: 10 }, client);

  assert.equal(client.seen[0].query, "go 1.27");
  assert.equal(pages.length, 2); // the two sources, nothing appended
  assert.deepEqual(pages[0], { title: "Go 1.27 Release Notes", url: "https://go.dev/doc/go1.27", text: "", age: "" });
  assert.equal(pages[1].url, "https://go.dev/blog/go1.27");
  // plugin.SearchPage has no `text` field, so a synthesis entry would reach Go
  // as {Title, URL:"", PageAge:nil} — an empty shell the host still renders.
  // Nothing empty-url is allowed onto the list, and the answer text is gone.
  assert.ok(pages.every((p) => p.url !== ""));
  assert.ok(!pages.some((p) => p.title.includes("检索摘要")));
  assert.ok(!JSON.stringify(pages).includes("Go 1.27 shipped"));
});

test("count bounds the documents", async () => {
  const pages = await searchInception({ query: "go", count: 1 }, mockClient(fullRun("answer")));
  assert.equal(pages.length, 1);
  assert.equal(pages[0].url, "https://go.dev/doc/go1.27");
});

test("the page count is the source count, with or without an answer", async () => {
  const withAnswer = await searchInception({ query: "go" }, mockClient(fullRun("Go 1.27 shipped [1][2].")));
  const withoutAnswer = await searchInception({ query: "go" }, mockClient(fullRun()));

  // 2 docs; the answer's presence changes nothing about the list.
  assert.equal(withAnswer.length, 2);
  assert.deepEqual(withAnswer, withoutAnswer);

  for (const count of [1, 2, 10]) {
    const capped = await searchInception({ query: "go", count }, mockClient(fullRun("answer")));
    assert.equal(capped.length, Math.min(count, 2));
  }
});

test("an empty run with no answer yields no pages", async () => {
  const pages = await searchInception({ query: "go" }, mockClient(`{"t":"docs","sources":[]}\n`));
  assert.deepEqual(pages, []);
});

test("an empty run with an answer still yields no pages", async () => {
  const pages = await searchInception({ query: "go" }, mockClient(`{"t":"docs","sources":[]}\n{"t":"answer_delta","d":"orphan"}\n`));
  assert.deepEqual(pages, []);
});

test("searchInception refuses an empty query", async () => {
  await assert.rejects(() => searchInception({ query: "   " }, mockClient(fullRun())), /needs a query/);
});

// ------------------------------------------------------- token rotation (Client)

const TOKEN = "1762100000." + "a".repeat(32) + "." + "b".repeat(64);

// clientWith scripts the search-lab responses and neutralises clearance: the
// PoW path is tested in review-fixes, not here.
function clientWith(script) {
  const calls = [];
  const c = new Client({
    fetchImpl: async (url) => {
      const u = String(url);
      if (!u.endsWith("/api/search-lab/run")) throw new Error(`test: unexpected fetch ${u}`);
      calls.push(u);
      const next = script.shift();
      if (!next) throw new Error("test: script exhausted");
      return next;
    },
  });
  c.clearance.ensure = async () => {};
  c.clearance.header = () => ({ ua: "test", cookie: "" });
  c.pool.fetchToken = async () => TOKEN;
  return { client: c, calls };
}

test("a rejected token is discarded and the search replayed", async () => {
  const { client, calls } = clientWith([
    new Response("nope", { status: 401 }),
    new Response(fullRun("answer")),
  ]);
  const resp = await client.search({ query: "go" });
  assert.equal(resp.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(await resp.text().then((t) => t.includes("run_start")), true);
});

test("exhausted token retries surface the 401", async () => {
  const { client, calls } = clientWith([
    new Response("nope", { status: 401 }),
    new Response("nope", { status: 403 }),
    new Response("nope", { status: 401 }),
  ]);
  await assert.rejects(() => client.search({ query: "go" }), (e) => e.status === 401);
  assert.equal(calls.length, 3); // 1 attempt + MAX_AUTH_RETRIES
});

test("a 429 passes through with Retry-After attached", async () => {
  const { client, calls } = clientWith([
    new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
  ]);
  await assert.rejects(() => client.search({ query: "go" }), (e) => e.status === 429 && e.retryAfter === "30");
  assert.equal(calls.length, 1); // rate limits are not retried with a new token
});
