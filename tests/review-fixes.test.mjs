// Regression locks for the 2026-11-03 review fixes (C-1, C-2, H-1, H-2, H-3).
import { test } from "node:test";
import assert from "node:assert/strict";

// ---- regression locks for the 2026-11-03 review fixes ----
test("foldHistory folds an all-tool-turn conversation (C-1)", async () => {
  const { foldHistory } = await import("../src/history-fold.mjs");
  const hist = [{ role: "user", texts: ["start"], calls: [] }];
  for (let i = 0; i < 50; i++) {
    hist.push({ role: "assistant", texts: [], calls: [{ id: "c" + i, function: { name: "t", arguments: "{}" } }] });
    hist.push({ role: "user", results: [{ callId: "c" + i, content: "r".repeat(3000) }] });
  }
  const r = foldHistory(hist, true);
  assert.equal(r.folded, true);
  assert.ok(r.hist.length <= 60, `folded length ${r.hist.length} must be capped`);
});

test("classifyNoCall separates undeclared-tool blocks and prose mentions (H-2)", async () => {
  const { classifyNoCall, RECOVERY_UNDECLARED, RECOVERY_CLEAN } = await import("../src/tools-recovery.mjs");
  const { CALL_START, CALL_END } = await import("../src/tools-parse.mjs");
  const S = CALL_START, E = CALL_END;
  assert.equal(classifyNoCall("x " + S + '{"name":"evil","arguments":{}}' + E, ["note"]), RECOVERY_UNDECLARED);
  assert.equal(classifyNoCall("what is function.name: in JS?", ["note"]), RECOVERY_CLEAN);
});

test("solveToken throws when the nonce budget is exhausted (H-1)", async () => {
  const { solveToken } = await import("../src/solve.mjs");
  const token = "2.1.1000." + Buffer.from("id;pre;ffffffffffffffffffffffffffffffff;1;bin").toString("base64") + ".sig";
  assert.throws(() => solveToken(token, 100), /nonce budget/);
});

test("clearance parks an acquired cookie even on a cooldown ring (C-2)", async () => {
  const { Clearance } = await import("../src/clearance.mjs");
  const c = new Clearance({ size: 2, fetchImpl: async () => { throw new Error("no net"); } });
  c.slots.forEach((s) => { s.state = "cooldown"; s.retryAt = Date.now() + 60_000; });
  c.parkCookie("_vcrcs=x");
  assert.equal(c.slots.filter((s) => s.state === "live").length, 1);
  assert.equal(c.header().cookie, "_vcrcs=x");
});

test("pool.get() tops up below max without blocking (H-3)", async () => {
  const { TokenPool } = await import("../src/session-pool.mjs");
  let seq = 0;
  const tok = () => String(1762100000 + seq++).padStart(10, "0") + "." + "a".repeat(32) + "." + "b".repeat(64);
  const pool = new TokenPool({ min: 1, max: 2, fetchToken: async () => tok() });
  const first = await pool.get();
  // The non-blocking top-up raced ahead while get() returned; either way the
  // pool must not be stuck below max after a tick.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(pool.tokens.length, 2);
  pool.discard(first);
  assert.ok(pool.tokens.length >= 1);
});
