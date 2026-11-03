# Changelog

## 0.2.0 — 2026-11-03

Review hardening + self-computed token usage.

- **Token usage now computed by the gateway** (upstream emits no usage events): every response — plain/tools × stream/non-stream — carries an OpenAI-shaped `usage`. Estimated at ~4 chars per Unicode code point over the real upstream request/answer; a display-and-quota figure, not a billing one.
- **Fold fix**: an all-tool-turn conversation now folds (folding boundaries are every atomic unit, not plain-user heads only) — a long tool session could previously never fold and deadlocked against the upstream 100-message cap.
- **Clearance fix**: an acquired cookie is parked even when every ring slot is in cooldown; previously a fresh cookie could be dropped on a dead slot and the next request re-challenged.
- **Solver fix**: exhausting the PoW nonce budget now throws instead of returning an invalid token that would burn a session-token round-trip per request.
- **Recovery classification**: a closed `<tool_call>` naming an undeclared tool is now `undeclared` (retry without replaying the hallucinated block), distinct from `parse_failed`; foreign-opener probes only count at line start, so a prose mention such as `function.name:` stays clean; closer detection inside a call body skips JSON string literals.
- **Pool top-up**: `TokenPool.get()` refills to max without blocking the answering request.
- **No logs**: every internal `console.log` path removed (the plugin surface has no log reader); model entries and the id→route map are built once at load instead of per request.
- Host contract: `refreshLead` set; magpie-sent settings no longer shadowed by hardcoded values.
- Tests: 17 cases — usage-shape locks on all four response paths, fold/classification/solver/pool regression locks.

## 0.1.0 — 2026-11-03

Initial release.

- Anonymous Mercury access: Vercel-checkpoint PoW clearance (ring of `_vcrcs` cookies, UA-bound, request-driven warmup), anonymous session-token pool (TTL 30 min, round-robin).
- OpenAI chat-completions surface: streaming (delayed header commit; empty answers → 502) and non-streaming; `reasoning_content` passthrough; `source-url` events → `annotations`.
- Tool-call bridging over the fenced `<tool_call>` protocol: manifest preamble, call parsing (streaming-safe, surrogate-aware), tool-result replay, and one bounded recovery retry per round (truncated / parse-failed / canned-refusal classification, switch-note scrub).
- Resilience: challenge → retire slot + replay once; plain 429 → retire slot, pass through; 401/403 → discard token, retry ≤ 2; "conversation is too long" below the 100-message cap → lazy session switch (identical replay once).
- magpie contract: keyless install-and-use sign-in, no-op refresh, usage identity without balance/windows, checkin "inactive", static never-empty catalog.
- Tests: 12 node --test cases (solver vectors, parser, chat behaviors with mock upstream).
