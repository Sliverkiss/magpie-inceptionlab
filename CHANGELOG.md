# Changelog

## 0.4.0 — 2026-11-07

- **`ensure()` no longer reads a healthy egress as a fatal clearance failure.** `solveOnce()` returning `""` means the edge has no challenge for this egress — nothing is parked, so `liveCount()` stays 0 *by design*. When a concurrent solve (an opportunistic `topUp`, or another request's) was already on the wire, `ensure()` awaited it and then, finding `liveCount() === 0`, threw `ClearanceError("clearance solve failed; no live cookie")` — a 503 on a perfectly healthy edge. Repro: one `ensure()`, then two concurrent ones; the second rejects. It now treats a fresh `probed` result as health and returns, and falls through to its own attempt only when the flight it joined belonged to someone else (a `topUp` swallows its failures, so its resolution says nothing about the edge). Genuine solve failures still reject with their typed error. Chat and search share the path, so both were affected.

- **One field, three contracts — split.** `ensure()`, `topUp()` and `forceAcquire()` all wrote the same `acquireInflight`, so `ensure()` had to infer *whose* promise it had just awaited from `probed`, and a `topUp`'s swallowed failure read as a healthy egress (that inference was the root of the 503 above). Now `solveInflight` holds only genuine attempts (`ensure` / `forceAcquire` — "hand me a cookie or throw") and `topUpInflight` holds the fire-and-forget refill, which nothing joins. `probed` is back to one job: "this egress was not challenged, skip the probe GET for one window".
- **Bounded second attempt, shared.** Recovery from a dead edge no longer costs one acquisition *per concurrent caller*: the first flight is shared, and when it rejects the first caller to resume installs a second attempt that everyone else joins. A wave of N concurrent `ensure()` costs **exactly 2** acquisitions (measured at N = 2 and N = 100) — 0.2.2's "traffic is capped by real request count" holds under concurrency. Both failures are stamped; the second attempt's typed error (`ClearanceError` / `RefusedError`) is what every caller receives.
- **The `searches` comment corrected** (`src/models.mjs`): it claimed that without the flag magpie "routes the search to its own provider on the assumption the model cannot" — overclaiming twice. `searchRank` is a *ranking*: returning -1 takes this model off magpie's search path, but a lower-ranked provider can still answer. And the upstream searches by itself only when the request carries no tool manifest (the chat body sets `webSearchEnabled: manifest == null`), so with tools declared the vendor runs its own server-side search off. The flag still does its job; the comment now says only that.
- Tests: 4 new cases — the two flights never crossing (`ensure` and `forceAcquire` each open their own request while a `topUp` is in the air, using a gated fake fetch that holds requests on the wire), the dead-edge acquisition count and per-caller typed error at N = 2 and N = 100, and the healthy-edge wave costing one probe GET. No test touches the network.

## 0.3.0 — 2026-11-06

Native web search: the plugin now answers magpie's `search` API, so a client's own `WebSearch` / `web_search` runs through the upstream retrieval pipeline instead of magpie's.

- **`search` hook** (`src/search.mjs`, id `inceptionlab`): `POST /api/search-lab/run` returns NDJSON — rewritten queries, ranked sources, and a content-grounded synthesis. `keyOptional: true`, not `auth`: the anonymous clearance cookie + session token already live in the module-level `Client`, and binding an account would make the host demand a sign-in the plugin never stores.
- **Terminal rules** (measured 2026-10-22): `run_done` ends the run and its `answer` wins, with the accumulated `answer_delta` text as the fallback; an `error` before `docs` fails the run, an `error` after `docs` keeps the retrieval and drops the answer; a body that closes after `docs` is a complete retrieval, one that closes before `docs` is truncation and never reads as an empty result set.
- **One line pump** (`src/lines.mjs`): the watchdog, byte buffer and abort race are now shared by the SSE and NDJSON families instead of each owning a copy — a drifting watchdog fails silently, so it gets one implementation. Sliding 60 s idle window (reset by every line) plus a 600 s absolute cap; per-line 16 MiB bound; an already-cancelled caller never reads. Retention: queries deduped and capped at 32 × 2000 runes, sources at 50 (http(s)-only, control-free, 512-rune titles), answer at 1 MiB.
- **Answer delivery: none, and it can't be fixed here.** `plugin.SearchPage` is `{Title string \`json:"title"\`; URL string \`json:"url"\`; PageAge any \`json:"page_age"\`}` — three fields, no `text`. The host's `runSearch` maps `text: str(r.text ?? r.content ?? r.snippet)` onto that struct, so the snippet is silently dropped at the boundary, and its `age` never matches the `page_age` tag, so `PageAge` is nil for every page. The plugin returns the source documents and discards the synthesis; `collectSearch` still reads the answer correctly (its terminal-rule tests are unchanged) but nothing downstream can receive it. An empty-`url` summary page was the previous shape and it was worse, not harmless: `runSearch` does not filter empty urls, so it reached the UI as a result that goes nowhere.
- **`Client.search`**: the plain 401/403 token rotation (discard + replay, ≤ 2 retries); 429 passes through with `retry-after` attached so magpie rests the account; a clearance failure becomes a 503. Node/Bun decode the body themselves, so the request asks for `identity` and no decoder sits in the path.
- **Model entries**: `searches: true` on every catalog entry — the chat body already sets `webSearchEnabled`, so the model answers search itself; without the field magpie routes around it.
- Tests: 36 cases — wire clamping, source normalization, every terminal rule, rune-split delta concatenation, retention caps, page shaping (the list is the source count, with or without an answer); token rotation and 429 passthrough; plus the shared pump's own contract (CRLF, tail line, STOP, per-line cap, idle window, absolute cap, pre-aborted signal).

## 0.2.2 — 2026-11-03

- **Background fill loop removed** (owner ruling): refills are demand-driven only. `ensure()` solves inline when the ring has no live cookie, and a retired slot waits for the next request that needs one. No background timer means the punitive window can't be amplified by a loop retrying a doomed solve every 1.5 s; total edge traffic during a penalty is bounded by real requests. Constructor still does one opportunistic warmup solve per session, never on a timer.

## 0.2.1 — 2026-11-03

Clearance hardening round 2 (post-review fixes).

- **Forced solve actually forces**: a challenge on the request path invalidates the probe cache (`noteChallenge`); previously a cached "unchallenged" answer would block every recovery solve for 45 minutes, turning the replay chain into a 503 loop.
- **Replay chain fixed**: every attempt captures the cookie that carried it and retires exactly that one on a challenge (previously the retire was a no-op on an already-retired cookie while the challenged spare stayed live); `forceAcquire` no longer clears a slot before solving (a throw can no longer drop a live cookie); `ensure()` no longer silently succeeds on a failed background solve.
- **Single-flight shared**: request path and opportunistic refill never launch two solves at once.
- **Client abort propagates**: `readSSE` now races the abort signal — a canceled request stops reading the upstream immediately instead of idling up to 60 s.
- **Status passthrough**: upstream 429/5xx statuses now reach magpie verbatim instead of collapsing to 502 (Retry-After semantics preserved).
- Tests: probe-cache invalidation, forced solve, single-flight, forceAcquire slot safety, retire pacing, SSE abort.

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
