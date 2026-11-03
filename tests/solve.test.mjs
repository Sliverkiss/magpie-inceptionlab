// Solver vector tests. Token layout: <version>.<seed>.<ttl>.<b64payload>.<sig>
// — the seed is the SECOND dot-part (clear_test.go's "seed 1000" comment
// misreads its own token "2.1.1000.…": 1 is the seed, 1000 the ttl). The
// offset math below is the protocol (solver.go), spelled out independently
// of the solver under test; the live acceptance test is the edge's 204.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { solveToken } from "../src/solve.mjs";

const MULTIPLIERS = [498787, 533737, 619763, 708403, 828071];
const keyOf = (seed) => Number((((seed * BigInt(MULTIPLIERS[Number(seed % 5n)]) % 36n)) + 36n) % 36n);
const offOf = (seed, round) => Number((((seed * BigInt(MULTIPLIERS[round % 5]) % 60n)) + 60n) % 60n);

test("solveToken solves a crafted one-round token correctly", () => {
  const target = "abcdef0123456789".repeat(4);
  const payload = `id;pre;${target};1;bin`;
  const token = "2.1.1000." + Buffer.from(payload).toString("base64") + ".sig";
  const sol = solveToken(token);
  const nonces = sol.split(";");
  assert.equal(nonces.length, 1);
  assert.match(nonces[0], /^[0-9a-f]{16}$/);
  // seed = 1 (second dot-part) → key = 1*mul[1] mod 36 = 1 → cur = target[1:5]
  const cur = target.slice(keyOf(1n), keyOf(1n) + 4);
  assert.equal(cur, "bcde");
  const digest = createHash("sha256").update("pre" + nonces[0]).digest("hex");
  assert.ok(digest.startsWith(cur), `digest ${digest.slice(0, 8)}… must start with ${cur}`);
});

test("solveToken chains 3 rounds (real challenge shape)", () => {
  const seed = 7n;
  const target = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";
  const payload = `id;pre;${target};3;bin`;
  const token = `2.${seed}.1000.` + Buffer.from(payload).toString("base64") + ".sig";
  const sol = solveToken(token);
  const nonces = sol.split(";");
  assert.equal(nonces.length, 3);

  let cur = target.slice(keyOf(seed), keyOf(seed) + 4);
  for (let i = 0; i < 3; i++) {
    const digest = createHash("sha256").update("pre" + nonces[i]).digest("hex");
    assert.ok(digest.startsWith(cur), `round ${i}: digest must start with ${cur}`);
    const off = offOf(seed, i);
    cur = digest.slice(off, off + 4);
  }
});

test("solveToken rejects malformed tokens", () => {
  assert.throws(() => solveToken("nonsense"));
  assert.throws(() => solveToken("2.1.1000.notb64!.sig"));
});
