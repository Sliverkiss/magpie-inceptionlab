// Model catalog for chat.inceptionlabs.ai.
//
// The upstream publishes no models endpoint (the web client ships one
// diffusion model), so this table is static — and it must never be empty:
// magpie shows it before anyone activates the provider, and provider.models
// falls back to it.
//
// limit/variants follow models.dev's `inception` entry (context 1M, output
// 128k); the reasoning efforts map onto the upstream's reasoningEffort values
// (low/medium/high — instant is the upstream's own lowest tier, surfaced as
// "low" here).

import { TEXT_ONLY } from "./chat.mjs";

const CATALOG = [
  { id: "mercury-3", name: "Mercury 3", context: 1_000_000, output: 131_072 },
];

export const STATIC_MODELS = CATALOG;

export function toStaticModel(m) {
  return {
    name: m.name,
    limit: { context: m.context, output: m.output },
    reasoning: true,
    tool_call: true,
    // Text-only: the upstream web client accepts no image parts.
    modalities: { input: ["text"], output: ["text"] },
    attachment: false,
    // Reasoning tiers: the keys become magpie's effort picker and ride the
    // request as reasoning_effort, which convert.mjs maps onto the upstream's
    // reasoningEffort. Instant (the web client's lowest tier) is reachable as
    // "low".
    variants: { low: {}, medium: {}, high: {} },
    // free: no account, no billing surface — feeds magpie's Free-first routing.
    free: true,
  };
}

// buildModelMap routes local ids to the (single) upstream model. The id
// derivation is one for both static and any future dynamic list, so an id
// always means the same upstream route.
export function buildModelMap(list) {
  const map = new Map();
  for (const m of list) map.set(m.id, { upstream: "mercury-3", textOnly: TEXT_ONLY });
  return map;
}
