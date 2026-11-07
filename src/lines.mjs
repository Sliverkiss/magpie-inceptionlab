// The one upstream line pump. Port of app/internal/upstream/lines.go.
//
// The upstream speaks two line protocols — SSE on /api/chat and NDJSON on
// /api/search-lab/run — and they differ only in what a line means. The
// watchdog, the byte buffer and the abort race are identical, so they live
// here once: a second copy would drift, and the failure mode of a drifting
// watchdog (a request that never times out, or one that times out mid-answer)
// is invisible until it is expensive.
//
// The pump: a sliding idle window reset by every received line, an optional
// absolute cap independent of it, and a bounded line buffer. It reports
// "stopped" when onLine returned STOP and "eof" when the body closed; every
// other outcome is a rejection the caller's own vocabulary handles.

export const STOP = Symbol("stop");

// maxLineChars bounds one line (SSE or NDJSON). The upstream sends large
// single-line JSON events, so the cap is generous. bufio.Scanner's bound is
// 16 MiB of bytes; here it is applied as code units, which is never looser
// for ASCII and at most 2x tighter for astral text — a safety cap either way.
export const MAX_LINE_CHARS = 16 << 20;

export const DEFAULT_IDLE_MS = 60_000;

// IdleTimeoutError covers both the sliding window and the absolute cap: from
// the caller's side they are the same event (the upstream stopped talking).
export class IdleTimeoutError extends Error {
  constructor(ms) {
    super(`upstream: stream idle for ${ms} ms`);
    this.name = "IdleTimeoutError";
    this.idleMs = ms;
  }
}

// AbortError: the caller's signal fired. Nothing is wrong upstream, so this is
// deliberately not an upstream error type.
export class AbortError extends Error {
  constructor() {
    super("upstream: request aborted");
    this.name = "AbortError";
  }
}

// LineTooLongError: one line outran the buffer. Fatal — the stream cannot be
// resynchronised, because the rest of the line is indistinguishable from the
// next event's start.
export class LineTooLongError extends Error {
  constructor(max) {
    super(`upstream: line exceeded ${max} chars`);
    this.name = "LineTooLongError";
    this.max = max;
  }
}

// pumpLines reads body, handing each complete line to onLine without its
// terminator. onLine returns STOP to end the pump at that line. Resolves
// "stopped" | "eof"; rejects on timeout, abort, over-long line, or transport
// error. A trailing line with no newline is delivered before "eof".
export async function pumpLines(body, onLine, { signal, idleMs = DEFAULT_IDLE_MS, capMs, maxLineChars = MAX_LINE_CHARS } = {}) {
  // An already-cancelled caller never gets a read: without this the first
  // read() and the abort race settle in an order nobody controls.
  if (signal?.aborted) throw new AbortError();
  const reader = body.getReader();
  const decoder = new TextDecoder();

  let idleTimer = null;
  let trip = null;
  const watchdog = new Promise((_, rej) => { trip = rej; });
  watchdog.catch(() => {}); // consumed through the race
  const arm = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => trip(new IdleTimeoutError(idleMs)), idleMs);
  };
  const capTimer = capMs > 0 ? setTimeout(() => trip(new IdleTimeoutError(capMs)), capMs) : null;
  // Client abort: stop reading the upstream immediately instead of idling out,
  // which would hold the connection for up to idleMs after the caller left.
  const abort = signal
    ? new Promise((_, rej) => signal.addEventListener("abort", () => rej(new AbortError()), { once: true }))
    : null;
  abort?.catch(() => {}); // when the pump wins the race, nobody awaits this

  // deliver drains every complete line out of buf. Returns true when onLine
  // ended the pump. The length cap is per line, not per buffer: one chunk can
  // legitimately hold hundreds of short events, and only a line that outruns
  // the buffer is unrecoverable.
  let buf = "";
  const deliver = () => {
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length > maxLineChars) throw new LineTooLongError(maxLineChars);
      if (onLine(line.endsWith("\r") ? line.slice(0, -1) : line) === STOP) return true;
    }
    if (buf.length > maxLineChars) throw new LineTooLongError(maxLineChars);
    return false;
  };

  arm();
  try {
    while (true) {
      const { value, done } = await Promise.race(abort ? [reader.read(), watchdog, abort] : [reader.read(), watchdog]);
      if (done) break;
      arm();
      buf += decoder.decode(value, { stream: true });
      if (deliver()) return "stopped";
    }
    // A body whose last event carries no trailing newline still counts.
    const tail = (buf + decoder.decode()).trim();
    if (tail !== "" && onLine(tail) === STOP) return "stopped";
    return "eof";
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (capTimer) clearTimeout(capTimer);
    try { await reader.cancel(); } catch { /* the body is gone either way */ }
  }
}
