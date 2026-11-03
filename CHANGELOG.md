# Changelog

## 0.1.0 — 2026-11-03

Initial release.

- Anonymous Mercury access: Vercel-checkpoint PoW clearance (ring of `_vcrcs` cookies, UA-bound, request-driven warmup), anonymous session-token pool (TTL 30 min, round-robin).
- OpenAI chat-completions surface: streaming (delayed header commit; empty answers → 502) and non-streaming; `reasoning_content` passthrough; `source-url` events → `annotations`.
- Tool-call bridging over the fenced `<tool_call>` protocol: manifest preamble, call parsing (streaming-safe, surrogate-aware), tool-result replay, and one bounded recovery retry per round (truncated / parse-failed / canned-refusal classification, switch-note scrub).
- Resilience: challenge → retire slot + replay once; plain 429 → retire slot, pass through; 401/403 → discard token, retry ≤ 2; "conversation is too long" below the 100-message cap → lazy session switch (identical replay once).
- magpie contract: keyless install-and-use sign-in, no-op refresh, usage identity without balance/windows, checkin "inactive", static never-empty catalog.
- Tests: 12 node --test cases (solver vectors, parser, chat behaviors with mock upstream).
