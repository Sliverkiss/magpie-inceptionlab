// handleChat behavior tests with a mock upstream client: plain streaming
// (delayed commit), empty completion → 502, tool-call bridging, recovery
// retries, and the error envelope table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleChat, setClient } from "../src/chat.mjs";
import { buildModelMap, STATIC_MODELS } from "../src/models.mjs";

const MODEL_MAP = buildModelMap(STATIC_MODELS);

// mockClient fakes Client.chat with scripted event sequences keyed by the
// request's first user text.
function mockClient(script) {
  return {
    chat(ureq, opts) {
      const first = ureq.messages.at(-1)?.parts?.[0]?.text ?? "";
      const key = Object.keys(script).find((k) => first.includes(k));
      const events = script[key] ?? [];
      return (async function* () {
        for (const ev of events) yield ev;
      })();
    },
  };
}

const ev = (type, extra = {}) => ({ type, ...extra });
const text = (t) => ev("text-delta", { delta: t });
const reasoning = (t) => ev("reasoning-delta", { delta: t });

async function readSSE(resp) {
  const raw = await resp.text();
  const frames = raw.split("\n\n").filter((s) => s.startsWith("data: "));
  return frames.map((f) => {
    const payload = f.slice(6);
    return payload === "[DONE]" ? "[DONE]" : JSON.parse(payload);
  });
}

test("plain non-stream: aggregates content and reasoning", async () => {
  setClient(mockClient({
    "hello": [reasoning("thinking..."), text("Hi"), text(" there")],
  }));
  const resp = await handleChat({
    body: JSON.stringify({ model: "mercury-3", messages: [{ role: "user", content: "hello" }] }),
    modelMap: MODEL_MAP,
  });
  assert.equal(resp.status, 200);
  const j = await resp.json();
  assert.equal(j.choices[0].message.content, "Hi there");
  assert.equal(j.choices[0].message.reasoning_content, "thinking...");
  assert.equal(j.choices[0].finish_reason, "stop");
  // Mercury has no usage events; the gateway estimates ~4 chars per token.
  assert.equal(j.usage.prompt_tokens, 2); // "hello" = 5 chars → ceil(5/4)
  assert.equal(j.usage.completion_tokens, 5); // "thinking...Hi there" = 18 chars
  assert.equal(j.usage.total_tokens, 7);
});

test("plain stream: role frame precedes content; finish carries [DONE] and usage", async () => {
  setClient(mockClient({
    "hello": [text("Hello"), text(" world")],
  }));
  const resp = await handleChat({
    body: JSON.stringify({ model: "mercury-3", stream: true, messages: [{ role: "user", content: "hello" }] }),
    modelMap: MODEL_MAP,
  });
  assert.equal(resp.status, 200);
  const frames = await readSSE(resp);
  assert.equal(frames.at(-1), "[DONE]");
  assert.deepEqual(frames[0].choices[0].delta, { role: "assistant" });
  const content = frames.slice(1, -1).map((f) => f.choices[0].delta.content).join("");
  assert.equal(content, "Hello world");
  const finish = frames.at(-2);
  assert.equal(finish.choices[0].finish_reason, "stop");
  assert.deepEqual(finish.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }); // 5+11 chars → ceil(5/4)+ceil(11/4)
});

test("empty completion → HTTP 502 upstream_empty (stream)", async () => {
  setClient(mockClient({ "hello": [ev("reasoning-start"), ev("reasoning-end")] }));
  const resp = await handleChat({
    body: JSON.stringify({ model: "mercury-3", stream: true, messages: [{ role: "user", content: "hello" }] }),
    modelMap: MODEL_MAP,
  });
  assert.equal(resp.status, 502);
  const j = await resp.json();
  assert.equal(j.error.code, "upstream_empty");
});

test("tool call: fenced block becomes tool_calls with finish_reason tool_calls", async () => {
  setClient(mockClient({
    "weather": [
      text('<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>'),
    ],
  }));
  const resp = await handleChat({
    body: JSON.stringify({
      model: "mercury-3",
      messages: [{ role: "user", content: "weather in tokyo?" }],
      tools: [{ type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object" } } }],
    }),
    modelMap: MODEL_MAP,
  });
  assert.equal(resp.status, 200);
  const j = await resp.json();
  const msg = j.choices[0].message;
  assert.equal(msg.tool_calls.length, 1);
  assert.equal(msg.tool_calls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { city: "Tokyo" });
  assert.equal(j.choices[0].finish_reason, "tool_calls");
  assert.equal(msg.content, "");
  // Tool-path usage counts the call name and arguments in completion tokens.
  assert.equal(j.usage.completion_tokens, 7); // "get_weather" + {"city":"Tokyo"} = 27 chars
  assert.equal(j.usage.total_tokens, j.usage.prompt_tokens + j.usage.completion_tokens);
});

test("tool result replay: role:tool rides as a user turn", async () => {
  setClient(mockClient({ "22": [text("Sunny, 22C")] }));
  const resp = await handleChat({
    body: JSON.stringify({
      model: "mercury-3",
      messages: [
        { role: "user", content: "weather in tokyo?" },
        { role: "assistant", tool_calls: [{ id: "call_x", type: "function", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } }] },
        { role: "tool", tool_call_id: "call_x", content: '{"temp":22}' },
      ],
      tools: [{ type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object" } } }],
    }),
    modelMap: MODEL_MAP,
  });
  assert.equal(resp.status, 200);
  const j = await resp.json();
  assert.equal(j.choices[0].message.content, "Sunny, 22C");
});

test("truncated call envelope → one recovery retry, retried answer wins", async () => {
  // Script keys are matched against the LAST message text; the retry turn
  // embeds the retry instruction ("was truncated mid-envelope"), so the
  // retry key must precede the broken-round key in insertion order.
  setClient(mockClient({
    "was truncated mid-envelope": [
      text('<tool_call>{"name":"get_weather","arguments":{"city":"Osaka"}}</tool_call>'),
    ],
    "alpharound": [
      text('Let me check. <tool_call>{"name":"get_weather","arguments":{"city":'),
    ],
  }));
  const resp = await handleChat({
    body: JSON.stringify({
      model: "mercury-3",
      messages: [{ role: "user", content: "alpharound please" }],
      tools: [{ type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object" } } }],
    }),
    modelMap: MODEL_MAP,
  });
  assert.equal(resp.status, 200);
  const j = await resp.json();
  // The retried round's call is emitted verbatim.
  assert.equal(j.choices[0].message.tool_calls?.[0]?.function.name, "get_weather");
  assert.deepEqual(JSON.parse(j.choices[0].message.tool_calls[0].function.arguments), { city: "Osaka" });
});

test("malformed request → 400 invalid_request_error", async () => {
  const resp = await handleChat({ body: "not json", modelMap: MODEL_MAP });
  assert.equal(resp.status, 400);
  const j = await resp.json();
  assert.equal(j.error.type, "invalid_request_error");
});

test("unknown model falls back to mercury-3", async () => {
  setClient(mockClient({ "hello": [text("ok")] }));
  const resp = await handleChat({
    body: JSON.stringify({ model: "nope", messages: [{ role: "user", content: "hello" }] }),
    modelMap: MODEL_MAP,
  });
  assert.equal(resp.status, 200);
  const j = await resp.json();
  assert.equal(j.model, "nope"); // the caller's label rides through
});

test("citations arrive as finish-frame annotations", async () => {
  setClient(mockClient({
    "search": [
      ev("source-url", { sourceId: "u1", url: "https://x.example/a", title: "A" }),
      text("grounded answer"),
    ],
  }));
  const resp = await handleChat({
    body: JSON.stringify({ model: "mercury-3", stream: true, messages: [{ role: "user", content: "search me" }] }),
    modelMap: MODEL_MAP,
  });
  const frames = await readSSE(resp);
  const finish = frames.at(-2);
  assert.equal(finish.choices[0].finish_reason, "stop");
  assert.equal(finish.choices[0].delta.annotations[0].url, "https://x.example/a");
});
