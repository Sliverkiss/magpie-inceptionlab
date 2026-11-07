// Shared line pump tests. Both upstream families (SSE chat, NDJSON search)
// sit on this module, so its contract is locked here once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pumpLines, STOP, AbortError, IdleTimeoutError, LineTooLongError, MAX_LINE_CHARS } from "../src/lines.mjs";

const enc = new TextEncoder();

function bodyOf(chunks) {
  const list = Array.isArray(chunks) ? chunks : [chunks];
  return new ReadableStream({
    start(c) {
      for (const ch of list) c.enqueue(typeof ch === "string" ? enc.encode(ch) : ch);
      c.close();
    },
  });
}

async function collect(chunks, opts = {}) {
  const seen = [];
  const outcome = await pumpLines(bodyOf(chunks), (line) => { seen.push(line); }, { idleMs: 5_000, ...opts });
  return { seen, outcome };
}

test("lines arrive without their terminator", async () => {
  const { seen, outcome } = await collect("a\nb\nc\n");
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.equal(outcome, "eof");
});

test("CRLF is stripped", async () => {
  const { seen } = await collect("a\r\nb\r\n");
  assert.deepEqual(seen, ["a", "b"]);
});

test("a final line with no newline is still delivered", async () => {
  const { seen, outcome } = await collect("a\nb");
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(outcome, "eof");
});

test("blank lines are delivered as empty strings", async () => {
  const { seen } = await collect("a\n\nb\n");
  assert.deepEqual(seen, ["a", "", "b"]);
});

test("STOP ends the pump and drops the rest of the body", async () => {
  const seen = [];
  const outcome = await pumpLines(bodyOf("a\nSTOP\nb\n"), (line) => {
    seen.push(line);
    return line === "STOP" ? STOP : undefined;
  });
  assert.deepEqual(seen, ["a", "STOP"]);
  assert.equal(outcome, "stopped");
});

test("a line split across chunks is reassembled", async () => {
  const bytes = enc.encode("hello world\n");
  const { seen } = await collect([bytes.slice(0, 5), bytes.slice(5)]);
  assert.deepEqual(seen, ["hello world"]);
});

test("many short lines in one chunk do not trip the length cap", async () => {
  const text = Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n") + "\n";
  const { seen } = await collect(text, { maxLineChars: 64 });
  assert.equal(seen.length, 200);
});

test("a line over the cap is fatal, not truncated", async () => {
  await assert.rejects(() => collect("x".repeat(100), { maxLineChars: 10 }), LineTooLongError);
});

test("a line over the default cap is fatal", async () => {
  await assert.rejects(() => collect("x".repeat(MAX_LINE_CHARS + 1)), LineTooLongError);
});

test("an idle body trips the watchdog", async () => {
  const hang = new ReadableStream({ start() { /* never settles */ } });
  await assert.rejects(() => pumpLines(hang, () => {}, { idleMs: 10 }), IdleTimeoutError);
});

test("the absolute cap fires even while lines keep arriving", async () => {
  // A body that emits one line per tick forever: the sliding window never
  // expires, so only the absolute cap can end it.
  const trickle = new ReadableStream({
    start(c) {
      const tick = () => { try { c.enqueue(enc.encode("keepalive\n")); } catch { /* closed */ } };
      const id = setInterval(tick, 2);
      setTimeout(() => { clearInterval(id); try { c.close(); } catch { /* closed */ } }, 200);
      tick();
    },
  });
  await assert.rejects(() => pumpLines(trickle, () => {}, { idleMs: 10, capMs: 40 }), IdleTimeoutError);
});

test("an already-aborted signal rejects without reading", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(() => pumpLines(bodyOf("a\n"), () => {}, { signal: ctrl.signal }), AbortError);
});
