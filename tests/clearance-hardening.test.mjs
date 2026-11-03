// Regression locks for the 2026-11-03 clearance hardening: forced solve on a
// challenged replay, probe-cache invalidation, single-flight, and the
// no-self-throttling contract (owner ruling: every failed solve is retryable
// by the next request — no global backoff, no cooldown, no background loop).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Clearance, ClearanceError, RefusedError } from "../src/clearance.mjs";

const COOKIE_A = "_vcrcs=cookieA";
const COOKIE_B = "_vcrcs=cookieB";
const COOKIE_C = "_vcrcs=cookieC";

// scriptedFetch answers from a queue of ({status, headers, setCookie}) frames;
// requests are recorded as {url, method}.
function scriptedFetch(frames) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    const fr = frames.shift() ?? { status: 200 };
    const headers = new Headers(fr.headers ?? {});
    const resp = new Response(fr.body ?? null, { status: fr.status, headers });
    if (fr.setCookie) resp.headers.getSetCookie = () => fr.setCookie;
    return resp;
  };
  return { fetchImpl: f, calls };
}

const challengeHeaders = () => ({
  "x-vercel-mitigated": "challenge",
  "x-vercel-challenge-token": "2.1.1000." +
    Buffer.from("id;pre;ffffffffffffffffffffffffffffffff;1;bin").toString("base64") + ".sig",
});
const solvedFrames = () => [
  { status: 429, headers: challengeHeaders() },
  { status: 204, setCookie: [`${COOKIE_C}; Path=/; Max-Age=3600`] },
];

test("forceAcquire parks a fresh cookie even when every slot is live", async () => {
  const { fetchImpl } = scriptedFetch(solvedFrames());
  const c = new Clearance({ size: 2, fetchImpl });
  c.parkCookie(COOKIE_A);
  c.parkCookie(COOKIE_B);
  assert.equal(c.liveCount(), 2);
  await c.forceAcquire();
  assert.equal(c.liveCount(), 2);
  assert.ok(c.slots.some((s) => s.cookie === COOKIE_C), "the fresh cookie replaced the oldest slot");
});

// ---- no-self-throttling contract (owner ruling) ----

test("a failed solve is retryable immediately: no backoff, no cooldown", async () => {
  let fail = true;
  const c = new Clearance({ size: 2, fetchImpl: async () => {
    if (fail) throw new Error("down");
    return "";
  }});
  await assert.rejects(() => c.ensure(), ClearanceError);
  assert.equal(c.backoffNow(), false, "no global backoff exists");
  // the very next attempt goes back to the wire
  fail = false;
  const { fetchImpl: f2 } = scriptedFetch(solvedFrames());
  c.fetchImpl = f2;
  await c.ensure();
  assert.equal(c.liveCount(), 1, "recovery on the immediate next attempt");
});

test("forceAcquire never refuses to run (backoff check removed)", async () => {
  const c = new Clearance({ size: 2, fetchImpl: scriptedFetch(solvedFrames()).fetchImpl });
  c.parkCookie(COOKIE_A);
  c.parkCookie(COOKIE_B);
  c.stampFailure(new Error("x")); // recorded, but must not gate anything
  await c.forceAcquire(); // must not throw "backed off"
  assert.ok(c.slots.some((s) => s.cookie === COOKIE_C));
});

test("stampFailure/stampSuccess are pure counters (no pacing fields)", async () => {
  const c = new Clearance({ size: 2, fetchImpl: async () => { throw new Error("x"); } });
  c.stampFailure(new Error("x"));
  c.stampFailure(new Error("y"));
  assert.ok(c.status().solveFailures >= 2);
  assert.ok(c.status().lastSolveError.includes("y"));
  assert.equal(c.backoffNow(), false);
  // no backoff fields left on the object
  assert.equal(c.backoffUntil, undefined);
  assert.equal(c.backoffMs, undefined);
});

// ---- recovery-path locks ----

test("RefusedError propagates and is counted (retryable by the next request)", async () => {
  const { fetchImpl } = scriptedFetch([
    { status: 429, headers: challengeHeaders() },
    { status: 403 }, // submit refuses the proof
  ]);
  const c = new Clearance({ size: 2, fetchImpl });
  await assert.rejects(() => c.ensure(), RefusedError);
  assert.ok(c.status().solveFailures > 0);
  assert.match(c.status().lastSolveError, /rejected the proof/);
});

test("solveOnce caches an unchallenged egress: no probe GET within PROBED_TTL", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    { status: 200 }, // probe 1: no challenge
    { status: 200 }, // would be probe 2 — must NOT be consumed
  ]);
  const c = new Clearance({ size: 2, fetchImpl });
  assert.equal(await c.solveOnce(), "", "unchallenged returns empty");
  assert.equal(await c.solveOnce(), "", "cached: no second probe");
  assert.equal(calls.length, 1, "only one probe GET went out");
  assert.equal(c.status().lastSolveError, "");
  // a real challenge clears the cache: next acquire probes again
  const { fetchImpl: f2, calls: calls2 } = scriptedFetch([
    { status: 200 }, // probe → cached unchallenged
    { status: 429, headers: challengeHeaders() }, // later acquire probes again
    { status: 204, setCookie: [`_vcrcs=${COOKIE_B}; Path=/`] },
  ]);
  const c2 = new Clearance({ size: 2, fetchImpl: f2 });
  await c2.solveOnce();
  c2.probedAt = Date.now() - 46 * 60_000; // expire the cache
  const cookie = await c2.solveOnce();
  assert.equal(cookie, `_vcrcs=${COOKIE_B}`, "real solve after the cache lapses");
  assert.equal(calls2.length, 3, "probe + solve after expiry");
});

// ---- review-fix regression locks (2026-11-03 second pass) ----

test("probe cache is invalidated the moment a request is challenged (noteChallenge)", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    { status: 200 }, // probe → cached unchallenged
  ]);
  const c = new Clearance({ size: 2, fetchImpl });
  await c.solveOnce();
  assert.equal(calls.length, 1);
  c.noteChallenge(); // a request just saw a challenge
  const { fetchImpl: f2, calls: calls2 } = scriptedFetch([
    { status: 429, headers: challengeHeaders() },
    { status: 204, setCookie: [`_vcrcs=${COOKIE_B}; Path=/`] },
  ]);
  c.fetchImpl = f2;
  const cookie = await c.solveOnce();
  assert.equal(cookie, `_vcrcs=${COOKIE_B}`, "solve re-probed after a challenge");
  assert.ok(calls2.length >= 2);
});

test("noteChallenge only records state, never paces (owner ruling)", async () => {
  const c = new Clearance({ size: 2, fetchImpl: async () => { throw new Error("x"); } });
  c.noteChallenge();
  assert.ok(c.status().lastChallengeAgeMs >= 0);
  assert.equal(c.backoffNow(), false, "challenge observation must not arm anything");
});

test("ensure() does not silently succeed on a failed inflight topUp (M1)", async () => {
  const { fetchImpl } = scriptedFetch([
    { status: 403 }, // topUp's solve fails
  ]);
  const c = new Clearance({ size: 2, fetchImpl });
  c.topUp();
  await assert.rejects(() => c.ensure(), ClearanceError);
});

test("forceAcquire keeps live cookies intact on failure (M2)", async () => {
  const c = new Clearance({ size: 2, fetchImpl: async () => { throw new Error("no net"); } });
  c.parkCookie(COOKIE_A);
  c.parkCookie(COOKIE_B);
  await assert.rejects(() => c.forceAcquire(), Error);
  assert.equal(c.liveCount(), 2, "both live cookies survive the failed forceAcquire");
});

test("retire() does not spawn a burst solve (M3): refills are demand-driven", async () => {
  const { fetchImpl, calls } = scriptedFetch([]);
  const c = new Clearance({ size: 2, fetchImpl });
  c.parkCookie(COOKIE_A);
  c.parkCookie(COOKIE_B);
  c.retire(COOKIE_A);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 0, "retire must not solve synchronously");
});

test("readSSE honors the abort signal promptly (H2 abort)", async () => {
  const { readSSE } = await import("../src/upstream.mjs");
  const body = new ReadableStream({ start() {} });
  const ctrl = new AbortController();
  const t0 = Date.now();
  const p = readSSE(body, () => {}, { signal: ctrl.signal, idleMs: 60_000 });
  setTimeout(() => ctrl.abort(), 10);
  await assert.rejects(() => p, Error);
  assert.ok(Date.now() - t0 < 1000, "abort ended the read far before the idle timeout");
});
