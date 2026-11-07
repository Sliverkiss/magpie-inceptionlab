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
    { status: 429, headers: challengeHeaders() }, // bounded second attempt, same verdict
    { status: 403 },
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

test("ensure() does not silently trust a failed inflight topUp (M1): it solves itself", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    { status: 403 }, // topUp's solve dies without a challenge token
    { status: 429, headers: challengeHeaders() }, // ensure()'s own attempt
    { status: 204, setCookie: [`${COOKIE_B}; Path=/`] },
  ]);
  const c = new Clearance({ size: 2, fetchImpl });
  c.topUp();
  await c.ensure();
  assert.equal(c.liveCount(), 1, "ensure() made its own solve instead of reading topUp's silence as success");
  assert.equal(c.status().solveFailures, 1, "topUp's failure is still counted");
  assert.equal(calls.length, 3, "one dead topUp probe, then a real probe + submit");
});

test("ensure() reports a genuine solve failure as a typed rejection (M1, negative half)", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    { status: 403 }, // topUp's solve fails
    { status: 403 }, // ensure()'s own attempt fails the same way
    { status: 403 }, // and so does its bounded second attempt
  ]);
  const c = new Clearance({ size: 2, fetchImpl });
  c.topUp();
  await assert.rejects(() => c.ensure(), ClearanceError);
  assert.equal(c.liveCount(), 0);
  assert.equal(calls.length, 3, "topUp's probe, then ensure's probe twice — never a stolen outcome");
});

// ---- "no challenge" is health, not failure (2026-11-03 bug) ----
//
// solveOnce() returning "" means the edge has no challenge for this egress:
// nothing is parked, so liveCount() stays 0 by design. ensure() used to read
// that healthy state as a fatal ClearanceError (→ 503) whenever the inflight
// it awaited belonged to someone else — the reported repro is one ensure(),
// then two concurrent ones.

test('ensure() treats a "no challenge" answer as healthy: no throw, liveCount stays 0', async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 200 }]); // edge not challenging
  const c = new Clearance({ size: 2, fetchImpl });
  await c.ensure();
  assert.equal(c.liveCount(), 0, "an unchallenged egress parks nothing");
  assert.equal(c.probed, true, "the probe result is cached");
  assert.equal(c.status().solveFailures, 0, "no challenge is not a failure");
  assert.equal(calls.length, 1, "one probe GET, no PoW, no submit");
});

test("repro: ensure() then concurrent ensure() x2 all resolve", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 200 }]);
  const c = new Clearance({ size: 2, fetchImpl });
  await c.ensure(); // warms the probe cache; liveCount 0, probed true
  assert.equal(c.liveCount(), 0);
  assert.equal(c.probed, true);
  const results = await Promise.allSettled([c.ensure(), c.ensure()]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "fulfilled"],
    "neither concurrent ensure() may reject on a healthy edge",
  );
  assert.equal(calls.length, 1, "the probe cache absorbs both: no extra round trip");
});

test("concurrent ensure() collapse onto one acquisition and both resolve", async () => {
  const { fetchImpl, calls } = scriptedFetch(solvedFrames());
  const c = new Clearance({ size: 2, fetchImpl });
  const results = await Promise.allSettled([c.ensure(), c.ensure()]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"]);
  assert.equal(c.liveCount(), 1, "exactly one cookie parked");
  assert.deepEqual(
    calls.map((x) => x.method),
    ["GET", "POST"],
    "one acquire = one probe GET + one submit POST, never two",
  );
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

// ---- split single-flights + bounded shared retry (2026-11-06) ----
//
// acquireInflight used to carry three contracts at once (ensure / topUp /
// forceAcquire), so ensure() had to infer "whose promise did I just await?"
// from `probed` — and a topUp's swallowed failure read as a healthy egress.
// Two fields, no inference. All fetches below are injected: nothing leaves
// the process.

// gatedFetch holds every request open until the test settles it by index, so
// a solve can be inspected mid-wire.
function gatedFetch() {
  const calls = [];
  const waiters = [];
  const fetchImpl = (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    return new Promise((resolve) => { waiters.push(resolve); });
  };
  const settle = (i, frame = { status: 200 }) => {
    const resolve = waiters[i];
    assert.ok(resolve, `no request was issued at index ${i}`);
    const resp = new Response(frame.body ?? null, {
      status: frame.status,
      headers: new Headers(frame.headers ?? {}),
    });
    if (frame.setCookie) resp.headers.getSetCookie = () => frame.setCookie;
    resolve(resp);
  };
  return { fetchImpl, calls, settle };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("ensure() never joins a topUp flight: solveInflight and topUpInflight are separate", async () => {
  const g = gatedFetch();
  const c = new Clearance({ size: 2, fetchImpl: g.fetchImpl });
  c.topUp(); // ring empty → topUp owns its own flight, held on the wire
  await tick();
  assert.equal(g.calls.length, 1, "topUp opened one probe");
  const ensured = c.ensure();
  await tick();
  assert.equal(g.calls.length, 2, "ensure() opened its own probe instead of joining the topUp");
  assert.notEqual(c.solveInflight, c.topUpInflight, "two contracts, two fields");
  g.settle(0, { status: 403 }); // the topUp dies; that failure is its own
  g.settle(1, { status: 429, headers: challengeHeaders() }); // ensure() gets a real challenge
  await tick();
  assert.equal(g.calls.length, 3, "ensure() submitted the solved token");
  g.settle(2, { status: 204, setCookie: [`${COOKIE_C}; Path=/`] });
  await ensured;
  assert.equal(c.liveCount(), 1, "ensure() solved for real while a dead topUp was in the air");
  assert.equal(c.status().solveFailures, 1, "the topUp failure is counted, and never becomes ensure()'s outcome");
});

test("forceAcquire() never resolves on a topUp flight (it must solve for real)", async () => {
  const g = gatedFetch();
  const c = new Clearance({ size: 2, fetchImpl: g.fetchImpl });
  c.topUp();
  await tick();
  const forced = c.forceAcquire();
  await tick();
  assert.equal(g.calls.length, 2, "forceAcquire() went to the wire instead of riding the topUp");
  assert.notEqual(forced, c.topUpInflight, "a swallowed topUp failure must never look like a fresh cookie");
  g.settle(0, { status: 403 }); // the topUp dies, silently
  g.settle(1, { status: 429, headers: challengeHeaders() });
  await tick();
  g.settle(2, { status: 204, setCookie: [`${COOKIE_B}; Path=/`] });
  await forced;
  assert.equal(c.liveCount(), 1, "the forced solve parked the cookie the topUp never could");
  assert.ok(c.slots.some((s) => s.cookie === COOKIE_B));
});

test("dead edge: N concurrent ensure() share exactly two acquisitions, every caller gets the typed error", async () => {
  // The [N, 2N] envelope is the unshared one. Sharing collapses both attempts
  // to one each, so the total is a constant 2 — the same number for 2 callers
  // and for 100. 0.2.2's promise is that traffic is capped by real requests,
  // not multiplied by them.
  for (const N of [2, 100]) {
    let acquires = 0;
    const c = new Clearance({
      size: 2,
      fetchImpl: async () => { acquires++; throw new Error("egress down"); },
    });
    const results = await Promise.allSettled(Array.from({ length: N }, () => c.ensure()));
    assert.equal(acquires, 2, `N=${N}: the wave costs exactly 2 acquisitions`);
    assert.ok(acquires <= 2 * N, `N=${N}: never above the per-caller ceiling`);
    assert.equal(c.liveCount(), 0);
    assert.ok(
      results.every((r) => r.status === "rejected" && r.reason instanceof ClearanceError),
      `N=${N}: every caller sees the typed ClearanceError, none a generic one`,
    );
    assert.equal(c.status().solveFailures, 2, `N=${N}: both shared failures are counted`);
    assert.equal(c.solveInflight, null, "the flight slot is released when the wave ends");
  }
});

test("healthy edge: N concurrent ensure() all fulfill on one acquisition", async () => {
  let acquires = 0;
  const c = new Clearance({
    size: 2,
    fetchImpl: async () => { acquires++; return new Response(null, { status: 200 }); },
  });
  const results = await Promise.allSettled(Array.from({ length: 100 }, () => c.ensure()));
  assert.ok(results.every((r) => r.status === "fulfilled"), "no caller rejects on a healthy edge");
  assert.equal(acquires, 1, "one probe GET for the whole wave");
  assert.equal(c.liveCount(), 0, "an unchallenged egress parks nothing");
  assert.equal(c.probed, true, "the probe result is cached");
  assert.equal(c.solveInflight, null);
});
