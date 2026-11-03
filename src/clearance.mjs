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
const COOLDOWN = 15_000; // per-slot retry spacing after a FAILED acquisition
const TIMEOUT = 30_000; // bounds one acquisition (GET + solve + POST)

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
// caller owns pacing (cooldown) and retries.
export async function acquire(fetchImpl) {
  const probe = await fetchChallenge(fetchImpl);
  if (probe.noChallenge) return ""; // edge stopped challenging this egress
  const { solveToken } = await import("./solve.mjs");
  const solution = solveToken(probe.token);
  const cookie = await submitSolution(fetchImpl, probe.token, solution);
  return cookie;
}

// Slot is one ring slot (SPEC §2.1.2): pending → live → (retire) → pending,
// or → cooldown after a failed acquisition.
const SlotPending = "pending";
const SlotLive = "live";
const SlotCooldown = "cooldown";

// Clearance is a small ring of cookies with lazy Ensure, slot Retire and a
// background fill loop. The chat path never waits for a solve unless the ring
// has nothing live (Ensure), because a challenged cookie retires and the
// request replays on the next live slot.
export class Clearance {
  constructor({ size = 2, fetchImpl = fetch } = {}) {
    this.size = Math.max(1, size);
    this.fetchImpl = fetchImpl;
    this.slots = Array.from({ length: this.size }, () => ({ state: SlotPending, cookie: "", acquired: 0, retryAt: 0 }));
    this.acquireInflight = null;
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
  retire(cookie) {
    if (!cookie) return;
    const slot = this.slots.find((s) => s.state === SlotLive && s.cookie === cookie);
    if (!slot) return;
    slot.state = SlotPending;
    slot.cookie = "";
    slot.acquired = 0;
    this.topUp();
  }

  // markFailed puts the slot that just failed acquisition into cooldown.
  markFailed() {
    const slot = this.slots.find((s) => s.state === SlotPending || s.state === SlotCooldown);
    if (!slot) return;
    slot.state = SlotCooldown;
    slot.retryAt = Date.now() + COOLDOWN;
  }

  // expireCooldowns flips cooldown slots whose retryAt has passed back to
  // pending, so pacing gates retries without ever wedging the ring: a ring of
  // nothing but cooldown slots would give ensure/topUp nowhere to park a
  // freshly acquired cookie (the solve would be silently discarded).
  expireCooldowns() {
    const now = Date.now();
    for (const s of this.slots) {
      if (s.state === SlotCooldown && now >= s.retryAt) {
        s.state = SlotPending;
        s.retryAt = 0;
      }
    }
  }

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

  // ensure guarantees at least one live cookie: it solves inline when the
  // ring has nothing live (the lazy fallback), collapsing concurrent callers
  // onto one acquisition. Never tops up a partially filled ring.
  async ensure() {
    if (this.liveCount() > 0) return;
    if (this.acquireInflight) return this.acquireInflight;
    this.expireCooldowns();
    this.acquireInflight = (async () => {
      try {
        const cookie = await acquire(this.fetchImpl);
        if (cookie) this.parkCookie(cookie);
      } catch (e) {
        if (e instanceof RefusedError) throw e; // never retried
        this.markFailed();
        throw e;
      } finally {
        this.acquireInflight = null;
      }
    })();
    return this.acquireInflight;
  }

  // topUp refills one pending slot in the background, request-driven: the
  // Client calls it after a successful request (and ensure() leaves it to
  // the next request when it fails). Guarded by one inflight acquire and
  // the per-slot cooldown, so a refusing edge sees a trickle, not a storm.
  topUp() {
    if (this.acquireInflight) return;
    if (this.liveCount() >= this.size) return;
    this.expireCooldowns();
    const now = Date.now();
    const target = this.slots.find(
      (s) => s.state === SlotPending || (s.state === SlotLive && now - s.acquired >= REFRESH),
    );
    if (!target) return;
    this.acquireInflight = (async () => {
      try {
        const cookie = await acquire(this.fetchImpl);
        // Empty cookie = edge stopped challenging: nothing to park, the ring
        // just stays as-is (header() sends without a cookie, which is right).
        if (cookie) this.parkCookie(cookie);
      } catch (e) {
        // RefusedError is never retried: leave the slot pending for the next
        // request; any other failure goes to cooldown.
        if (!(e instanceof RefusedError)) this.markFailed();
      } finally {
        this.acquireInflight = null;
      }
    })();
  }
}
