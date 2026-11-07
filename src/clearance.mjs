// Vercel Security Checkpoint v2 clearance for chat.inceptionlabs.ai.
// Port of app/internal/clear/clear.go. The design is the one verified live:
// clearance requires the _vcrcs cookie + the Chrome UA that solved it, on
// every request. It is NOT bound to a TLS fingerprint.
//
// The cookie is UA-bound, so UserAgent must never diverge between the
// acquisition and the request paths.

export const BASE = "https://chat.inceptionlabs.ai";

// The single Chrome UA used for clearance acquisition and every upstream
// request (clear.go UserAgent verbatim).
export const UserAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const challengePath = "/.well-known/vercel/security/request-challenge";
export const CookieName = "_vcrcs";

// Lifecycle defaults (clear.go).
const REFRESH = 45 * 60_000; // proactive replace age; edge TTL is 60m
const TIMEOUT = 30_000; // bounds one acquisition (GET + solve + POST)
// No backoff, no cooldown, no background loop (owner ruling): the punitive
// edge recovers on its own schedule (~210s measured), and every refill is
// demand-driven — ensure() solves inline when the ring is empty, and the next
// request retries as soon as the edge relents. The shared single-flight is
// what keeps concurrent callers from stampeding.
// How long a "this egress is not challenged" probe result is trusted. Same
// reasoning as REFRESH: the edge re-evaluates egress trust on a cookie-like
// schedule (clear.go probed/probedAt).
const PROBED_TTL = 45 * 60_000;

// ErrRefused means the edge rejected the proof of work itself (checkpoint
// version drift). Retrying cannot help.
export class RefusedError extends Error {
  constructor(msg) { super(msg); this.name = "RefusedError"; this.refused = true; }
}
export class ClearanceError extends Error {
  constructor(msg) { super(msg); this.name = "ClearanceError"; this.clearance = true; }
}

// isChallenge reports whether an upstream Response is a Vercel checkpoint
// challenge (clear.go IsChallenge): a 429 with the mitigated header or a
// challenge token.
export function isChallenge(resp) {
  if (resp.status !== 429) return false;
  if (String(resp.headers.get("x-vercel-mitigated") ?? "").includes("challenge")) return true;
  return resp.headers.get("x-vercel-challenge-token") != null;
}

// apiProbeHeaders: a probe must look like a business API request, not a
// navigation. Vercel waves navigate-shaped requests through with a plain 200,
// which would falsely read as "no clearance needed" and leave the ring empty.
function apiProbeHeaders() {
  const h = new Headers();
  h.set("user-agent", UserAgent);
  h.set("accept", "*/*");
  h.set("accept-language", "en-US,en;q=0.9");
  return h;
}

// fetchChallenge GETs /api/session without a cookie and returns the challenge
// token. 200 = no challenge needed (errNoChallenge); 429/403 + token = one
// challenge; anything else is a typed failure.
async function fetchChallenge(fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new ClearanceError("challenge probe timeout")), TIMEOUT);
  try {
    const resp = await fetchImpl(`${BASE}/api/session`, {
      headers: apiProbeHeaders(),
      signal: ctrl.signal,
    });
    await resp.body?.cancel();
    const token = resp.headers.get("x-vercel-challenge-token");
    if (resp.status === 200) return { noChallenge: true };
    if (resp.status !== 429 && resp.status !== 403) {
      throw new ClearanceError(`expected challenge, got HTTP ${resp.status}`);
    }
    if (!token) throw new ClearanceError("challenge response carried no x-vercel-challenge-token");
    return { token };
  } catch (e) {
    if (e instanceof ClearanceError) throw e;
    throw new ClearanceError(`fetch challenge: ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
  }
}

// submitSolution POSTs the solved token; 204/200 sets the _vcrcs cookie,
// 403 rejects the proof itself (never retried).
async function submitSolution(fetchImpl, token, solution) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new ClearanceError("submit timeout")), TIMEOUT);
  try {
    const resp = await fetchImpl(`${BASE}${challengePath}`, {
      method: "POST",
      headers: new Headers({
        "user-agent": UserAgent,
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        origin: BASE,
        referer: `${BASE}/.well-known/vercel/security/static/challenge.v2.min.js`,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "x-vercel-challenge-token": token,
        "x-vercel-challenge-solution": solution,
        "x-vercel-challenge-version": "2",
      }),
      signal: ctrl.signal,
    });
    await resp.body?.cancel();
    if (resp.status === 403) {
      throw new RefusedError("the checkpoint rejected the proof of work (version drift?)");
    }
    if (resp.status !== 204 && resp.status !== 200) {
      throw new ClearanceError(`submission: HTTP ${resp.status}`);
    }
    const cookies = resp.headers.getSetCookie?.() ?? [];
    const vc = cookies.find((c) => c.startsWith(CookieName));
    if (!vc) throw new ClearanceError("submission: no _vcrcs cookie in Set-Cookie");
    return vc.split(";")[0]; // "name=value"
  } catch (e) {
    if (e instanceof ClearanceError || e instanceof RefusedError) throw e;
    throw new ClearanceError(`submit solution: ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
  }
}

// acquire solves one challenge and returns a cookie string. One attempt; the
// caller owns pacing (cooldown) and retries. A 200 probe returns "" — the
// caller records it via recordProbed() so later acquisitions skip the probe
// GET for one refresh window (the edge re-evaluates egress trust on the same
// schedule a cookie would lapse).
export async function acquire(fetchImpl) {
  const probe = await fetchChallenge(fetchImpl);
  if (probe.noChallenge) return ""; // edge stopped challenging this egress
  const { solveToken } = await import("./solve.mjs");
  const solution = solveToken(probe.token);
  const cookie = await submitSolution(fetchImpl, probe.token, solution);
  return cookie;
}

// Slot is one ring slot (SPEC §2.1.2): pending → live → (retire) → pending.
// No cooldown state: failed solves are retryable by the next request
// (owner ruling — no self-throttling; the edge recovers on its own schedule).
const SlotPending = "pending";
const SlotLive = "live";

// Clearance is a small ring of cookies with lazy Ensure and slot Retire. The
// chat path never waits for a solve unless the ring has nothing live
// (Ensure), because a challenged cookie retires and the request replays on
// the next live slot; every refill is demand-driven.
export class Clearance {
  constructor({ size = 2, fetchImpl = fetch } = {}) {
    this.size = Math.max(1, size);
    this.fetchImpl = fetchImpl;
    this.slots = Array.from({ length: this.size }, () => ({ state: SlotPending, cookie: "", acquired: 0, retryAt: 0 }));
    // Two independent single-flights, because two callers want two different
    // contracts out of the same promise:
    //   solveInflight  ensure() / forceAcquire() — "hand me a cookie or throw".
    //   topUpInflight  topUp() — fire-and-forget; it swallows its own failure.
    // One shared field made ensure() have to infer *whose* flight it had just
    // awaited from `probed`, and that inference is exactly what read a dead
    // topUp as a healthy egress. Separate fields, no inference.
    this.solveInflight = null;
    this.topUpInflight = null;
    // status() reads these counters for diagnostics.
    this.lastSolveAt = 0;
    this.solves = 0; // real solves (probe GET + PoW + POST) that returned a cookie
    this.solveFailures = 0;
    this.lastSolveError = "";
    this.lastChallengeAt = 0; // a request observed a challenge
    // probed: the edge said "no challenge needed" (acquire returned "").
    // Clearing the ring re-probes only after PROBED_TTL — without this, an
    // unchallenged egress pays one GET /api/session per request for nothing.
    this.probed = false;
    this.probedAt = 0;
  }

  // recentlyProbed reports whether a "this egress is not challenged" answer
  // is still inside its trust window. Its only job now: skip the probe GET
  // for one refresh window, instead of paying it on every request.
  recentlyProbed() {
    return this.probed && Date.now() - this.probedAt < PROBED_TTL;
  }

  // solveOnce runs one acquisition with the probe cache: when a previous
  // acquire returned "" within PROBED_TTL, skip the probe GET entirely and
  // report "unchallenged" again. Any solve that comes back with a real
  // cookie clears the flag — the edge is challenging again.
  async solveOnce() {
    if (this.recentlyProbed()) return "";
    const now = Date.now();
    const cookie = await acquire(this.fetchImpl);
    if (cookie) {
      this.probed = false;
      this.probedAt = 0;
    } else {
      this.probed = true;
      this.probedAt = now;
    }
    return cookie;
  }

  // status is the magpie usage hook's view of clearance health: live slots
  // and solve counters.
  status() {
    const now = Date.now();
    return {
      slots: this.size,
      live: this.liveCount(),
      solves: this.solves,
      solveFailures: this.solveFailures,
      lastSolveError: this.lastSolveError,
      lastSolveAgeMs: this.lastSolveAt ? now - this.lastSolveAt : -1,
      lastChallengeAgeMs: this.lastChallengeAt ? now - this.lastChallengeAt : -1,
    };
  }

  // noteChallenge records that a REQUEST was challenged. This is the only
  // path that invalidates the probe cache: the edge's "no challenge" answer
  // (probed) is falsified the moment a real request is challenged, and
  // without this the cache would block every recovery solve for PROBED_TTL.
  noteChallenge() {
    this.lastChallengeAt = Date.now();
    this.probed = false;
    this.probedAt = 0;
  }

  // backoffNow reports whether acquisitions are globally paused. Always
  // false: the global backoff was removed at owner's ruling.
  backoffNow() {
    return false;
  }

  // stampFailure records a failed solve (counters only; no pacing).
  stampFailure(err) {
    this.lastSolveAt = Date.now();
    this.solveFailures++;
    this.lastSolveError = String(err?.message ?? err ?? "").slice(0, 200);
  }

  stampSuccess() {
    this.lastSolveAt = Date.now();
    this.solves++;
    this.lastSolveError = "";
  }

  // header returns the UA and the first live, non-stale cookie, or nulls.
  header() {
    const now = Date.now();
    const slot = this.slots.find((s) => s.state === SlotLive && now - s.acquired < REFRESH);
    return slot ? { ua: UserAgent, cookie: slot.cookie } : { ua: UserAgent, cookie: "" };
  }

  // liveCount reports how many slots hold a fresh cookie.
  liveCount() {
    const now = Date.now();
    return this.slots.filter((s) => s.state === SlotLive && now - s.acquired < REFRESH).length;
  }

  // retire drops the slot carrying exactly this cookie (""-valued misses are
  // ignored, mirroring the Go Retire semantics for an unprotected probe).
  // No refill here: the next request's ensure() solves inline when the ring
  // empties, so a retired slot is refilled on demand, never in a burst.
  retire(cookie) {
    if (!cookie) return;
    const slot = this.slots.find((s) => s.state === SlotLive && s.cookie === cookie);
    if (!slot) return;
    slot.state = SlotPending;
    slot.cookie = "";
    slot.acquired = 0;
  }

  // markFailed is kept as a no-op for call-site compatibility: per-slot
  // cooldowns were removed at owner's ruling (no self-throttling — the edge
  // recovers on its own schedule and every failed solve must be retryable by
  // the very next request).
  markFailed() {}

  // expireCooldowns is a no-op: no slot state uses cooldown anymore.
  expireCooldowns() {}

  // parkCookie writes a freshly acquired cookie into a usable slot,
  // pre-empting the oldest slot when the ring has none — an acquired cookie is
  // never discarded.
  parkCookie(cookie) {
    let slot = this.slots.find((s) => s.state === SlotPending);
    if (!slot) {
      slot = this.slots.find((s) => s.state === SlotLive && Date.now() - s.acquired >= REFRESH)
        ?? this.slots.reduce((a, b) => (a.acquired <= b.acquired ? a : b));
    }
    slot.state = SlotLive;
    slot.cookie = cookie;
    slot.acquired = Date.now();
    slot.retryAt = 0;
  }

  // runSolve is the acquisition body every real flight shares: one solveOnce,
  // counters stamped, a cookie parked on success. A rejection propagates
  // typed — deciding whether to retry belongs to the caller.
  async runSolve() {
    try {
      const cookie = await this.solveOnce();
      if (cookie) {
        this.stampSuccess(); // only real solves count as solves
        this.parkCookie(cookie);
      }
      // "" = edge not challenging; nothing to park, header() sends bare
    } catch (e) {
      this.stampFailure(e);
      throw e;
    }
  }

  // startSolve installs runSolve() as the shared solve flight and releases the
  // field the instant it settles — `.finally` runs before any awaiter resumes,
  // so a caller that retries never finds a dead flight in the slot (and never
  // clobbers one that replaced it).
  startSolve() {
    const flight = this.runSolve().finally(() => {
      if (this.solveInflight === flight) this.solveInflight = null;
    });
    this.solveInflight = flight;
    return flight;
  }

  // startTopUp is the same acquisition under the fire-and-forget contract: the
  // failure is stamped inside runSolve() and swallowed here, because nothing
  // is waiting on this flight.
  startTopUp() {
    const flight = this.runSolve().catch(() => {});
    this.topUpInflight = flight;
    flight.finally(() => {
      if (this.topUpInflight === flight) this.topUpInflight = null;
    });
    return flight;
  }

  // ensure guarantees at least one live cookie: it solves inline when the ring
  // has nothing live (the lazy fallback), collapsing concurrent callers onto
  // one acquisition. No global pacing: a failed solve is retryable by the next
  // request.
  //
  // Bounded at two attempts, and both are shared. The first is the flight
  // every concurrent caller joins; if it rejects, the first caller to resume
  // installs a second attempt and the rest join that one — so a dead edge
  // costs two acquisitions per wave, not one per caller (0.2.2's promise that
  // total traffic is capped by real request count). The second attempt's
  // rejection is the caller's, typed: nothing is swallowed here.
  //
  // A "" result is health, not failure: an unchallenged egress parks nothing,
  // so liveCount() stays 0 by design and header() sends bare.
  async ensure() {
    if (this.liveCount() > 0) return;
    const first = this.solveInflight ?? this.startSolve();
    try {
      await first;
    } catch {
      // solveInflight only ever holds a genuine attempt (topUp's lives in
      // topUpInflight), so this failure is real: fall through to the shared
      // second attempt instead of throwing on the first one.
    }
    if (this.liveCount() > 0 || this.recentlyProbed()) return;
    return this.solveInflight ?? this.startSolve();
  }

  // topUp refills one pending slot after a successful session fetch — one
  // opportunistic solve per session, never a timer. It never joins a real
  // solve (a caller that needs a cookie is already solving) and never blocks
  // one; its own flight lives in topUpInflight and its failures stay there.
  // Recovery does not depend on it: ensure() solves inline whenever the ring
  // is empty.
  topUp() {
    if (this.solveInflight || this.topUpInflight) return;
    if (this.backoffNow()) return;
    if (this.liveCount() >= this.size) return;
    this.expireCooldowns();
    const now = Date.now();
    const target = this.slots.find(
      (s) => s.state === SlotPending || (s.state === SlotLive && now - s.acquired >= REFRESH),
    );
    if (!target) return;
    this.startTopUp();
  }

  // forceAcquire solves once regardless of slot state (the request path's
  // last resort when even the spare cookie was challenged). The probe cache
  // is bypassed — the caller just observed a challenge, so "unchallenged" is
  // stale by definition. It joins a real solve flight if one is in the air
  // (that flight is a genuine attempt, so its outcome is an answer); it never
  // joins a topUp, whose swallowed failure would look like success. No slot
  // is touched before the solve: parkCookie pre-empts the oldest slot on
  // success.
  forceAcquire() {
    if (this.solveInflight) return this.solveInflight;
    const flight = (async () => {
      try {
        this.probed = false;
        this.probedAt = 0;
        const cookie = await acquire(this.fetchImpl);
        if (cookie) {
          this.stampSuccess();
          this.parkCookie(cookie);
        } else {
          this.stampSuccess(); // edge said "no challenge" — healthy signal
          this.probed = true;
          this.probedAt = Date.now();
        }
      } catch (e) {
        this.stampFailure(e);
        throw e;
      } finally {
        if (this.solveInflight === flight) this.solveInflight = null;
      }
    })();
    this.solveInflight = flight;
    return flight;
  }
}
