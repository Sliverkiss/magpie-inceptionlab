// Anonymous session token pool for chat.inceptionlabs.ai. Port of
// app/internal/pool/pool.go. Tokens are free and not IP-bound: the pool holds
// between min and max tokens, replaces them on TTL expiry, and discards one
// only when the upstream explicitly rejects it (401/403).

import { ClearanceError } from "./clearance.mjs";

const TTL = 30 * 60_000;

// Token shape bounds: {unix_ts}.{32 hex}.{64 hex} (10-digit unix until 2286).
const TS_RE = /^\d{10,11}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const SIGN_RE = /^[0-9a-f]{64}$/;
const MIN_TOKEN_LEN = 10 + 1 + 32 + 1 + 64;
const MAX_TOKEN_LEN = 11 + 1 + 32 + 1 + 64;

// validateToken checks the documented shape (pool.go ValidateToken).
export function validateToken(token) {
  if (typeof token !== "string" || token.length < MIN_TOKEN_LEN || token.length > MAX_TOKEN_LEN) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [ts, nonce, sign] = parts;
  if (!TS_RE.test(ts)) return false;
  if (!NONCE_RE.test(nonce)) return false;
  if (!SIGN_RE.test(sign)) return false;
  return true;
}

// Pool keeps the tokens and serialises fetches so a burst of requests cannot
// start a session-handshake storm.
export class TokenPool {
  constructor({ min = 1, max = 2, fetchToken, ttl = TTL, now = Date.now } = {}) {
    this.min = min;
    this.max = max;
    this.ttl = ttl;
    this.fetchToken = fetchToken;
    this.now = now;
    this.tokens = []; // {value, created}
    this.fetchInflight = null;
  }

  stats() {
    const t = this.now();
    let live = 0, expired = 0;
    for (const tok of this.tokens) (t - tok.created >= this.ttl ? expired++ : live++);
    return { size: this.tokens.length, live, expired, min: this.min, max: this.max };
  }

  // get returns a live token, keeping the pool at min..max: below min it
  // blocks on one shared fill; between min and max it tops up without
  // blocking, so losing one token restores the two-slot rotation (a challenged
  // or rate-limited slot still leaves a live spare).
  async get() {
    const t = this.now();
    this.tokens = this.tokens.filter((tok) => t - tok.created < this.ttl);
    if (this.tokens.length <= 0) {
      if (this.tokens.length < this.min) await this.fill();
      if (this.tokens.length > 0) return this.pick();
      throw new ClearanceError("pool: no session token available");
    }
    if (this.tokens.length < this.max) this.fill().catch(() => {});
    return this.pick();
  }

  pick() {
    // round-robin over the live tokens
    const tok = this.tokens.shift();
    this.tokens.push(tok);
    return tok.value;
  }

  // fill runs one shared fetch up to max. Each fetched token enters the pool
  // as soon as it validates: a later failure keeps the earlier ones instead of
  // discarding a half-successful handshake.
  async fill() {
    if (this.fetchInflight) return this.fetchInflight;
    this.fetchInflight = (async () => {
      try {
        while (this.tokens.length < this.max) {
          const value = await this.fetchToken();
          if (!validateToken(value)) {
            throw new ClearanceError(`pool: malformed session token ${String(value).slice(0, 16)}`);
          }
          this.tokens.push({ value, created: this.now() });
        }
      } finally {
        this.fetchInflight = null;
      }
    })();
    return this.fetchInflight;
  }

  // discard drops exactly this token (401/403 / too-long switch).
  discard(token) {
    this.tokens = this.tokens.filter((tok) => tok.value !== token);
  }

  // replenish refills to min after a discard (fire-and-forget; errors are
  // swallowed — the next get() retries).
  replenish() {
    if (this.tokens.length >= this.min) return;
    this.fill().catch(() => {});
  }
}
