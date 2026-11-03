// Port of /Users/loh/inceptionlabs2api/app/internal/clear/solver.go solveToken.
// v2 proof-of-work: 3-round SHA-256 partial-prefix chain over the challenge
// token's <version>.<seed>.<ttl>.<b64payload>.<sig> layout.
import { createHash } from "node:crypto";

const PREFIX_LEN = 4;
const MULTIPLIERS = [498787, 533737, 619763, 708403, 828071];
// A 4-hex prefix hits in ~65536 hashes; 2^26 is ~4000x that margin. Beyond it
// the challenge is malformed/adversarial: fail fast instead of hanging the
// inflight acquire (every later request would collapse onto the dead loop).
const MAX_NONCE = 1 << 26;

export function solveToken(token, maxNonce = MAX_NONCE) {
  const parts = token.split(".");
  if (parts.length < 4) {
    throw new Error(`malformed token: ${parts.length} dot-parts`);
  }
  const seed = BigInt(parts[1]);
  const raw = Buffer.from(parts[3], "base64").toString("utf8");
  const fields = raw.split(";");
  if (fields.length < 4) throw new Error(`payload fields: ${fields.length}`);
  const [id, prefix, target, roundsStr] = fields;
  const rounds = parseInt(roundsStr, 10);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error(`rounds: ${roundsStr}`);

  // key = seed*multiplier(seed mod 5) mod 36 -> start offset into target.
  const mul = BigInt(MULTIPLIERS[Number(((seed % 5n) + 5n) % 5n)]);
  const key = Number((((seed * mul) % 36n) + 36n) % 36n);
  if (target.length < key + PREFIX_LEN) throw new Error("target too short for key offset");
  let cur = target.slice(key, key + PREFIX_LEN);

  const out = [];
  let nonce = 0;
  for (let i = 0; i < rounds; i++) {
    let found = false;
    while (!found) {
      if (nonce > maxNonce) throw new Error(`nonce budget exhausted in round ${i}`);
      const h = nonce.toString(16).padStart(16, "0");
      nonce++;
      const digest = createHash("sha256").update(prefix + h).digest("hex");
      if (!digest.startsWith(cur)) continue;
      out.push(h);
      const off = Number((((seed * BigInt(MULTIPLIERS[i % 5])) % 60n) + 60n) % 60n);
      cur = digest.slice(off, off + PREFIX_LEN);
      found = true;
    }
  }
  return out.join(";");
}
