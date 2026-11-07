// inceptionlab — magpie provider plugin for Inception Mercury
// (chat.inceptionlabs.ai).
//
// The upstream is an ANONYMOUS diffusion-LLM web app: no account, no key. The
// edge sits behind a Vercel Security Checkpoint whose _vcrcs clearance cookie
// is solved here (3-round SHA-256 proof of work), and /api/chat rides an
// anonymous session token from /api/session. See src/clearance.mjs and
// src/session-pool.mjs.
//
// magpie contract consequences (same host contract dsh2api verified against
// host-2fffa1445f27.js):
//   - "Install and use" = one keyless api-type sign-in; authorize() must
//     return the terminal {type:"success"} object immediately, no network
//     probes (a spinning login button reads as a hang).
//   - expires:0 records are never renewed; refresh() is a no-op.
//   - no credits exist upstream: usage returns identity only — never balance
//     (keysSum wants a bare number string), never windows/plan. Clearance
//     failures surface as 503/429 responses, which magpie's own fallback
//     machinery rests the account on — the plugin doesn't second-guess it.
//   - checkin: no check-in activity exists → the valid "inactive" outcome.
//   - provider.models falls back to the static table, never an empty map.
//   - every fetch error maps into the OpenAI error envelope; there is no
//     login state to invalidate, so nothing ever surfaces as 401.

import * as up from "./src/upstream.mjs";
import { Client } from "./src/upstream.mjs";
import { handleChat, setClient, errorResponse } from "./src/chat.mjs";
import { STATIC_MODELS, toStaticModel, buildModelMap } from "./src/models.mjs";
import { searchInception, collectSearch, buildSearchRequest, normalizeSources } from "./src/search.mjs";

const PROVIDER = "inceptionlab";

// Built once: the catalog is static, so the host-facing model entries and the
// id→route map never change after module load.
const MODEL_ENTRIES = Object.fromEntries(STATIC_MODELS.map((m) => [m.id, toStaticModel(m)]));
const MODEL_MAP = buildModelMap(STATIC_MODELS);

export const InceptionlabPlugin = async () => {
  const client = new Client();
  setClient(client);

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "Mercury Inception",
        npm: "@ai-sdk/openai-compatible",
        api: `${up.BASE}/v1`,
        models: MODEL_ENTRIES,
      };
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: 2,
      refreshLead: 5 * 60_000,

      methods: [{
        type: "api",
        label: "启用 Inception Mercury（匿名，无需密钥）",
        keyless: true,
        async authorize() {
          // api-type dispatch calls authorize() directly and wants the
          // terminal object; failure must throw. No network here: the
          // clearance PoW warmup happens at plugin load (Client ctor), and
          // session tokens lazily on first request.
          return { type: "success", key: "anonymous", expires: 0 };
        },
      }],

      // Nothing to renew: expires:0 accounts are never renewed and there are
      // no credentials.
      async refresh() {
        return undefined;
      },

      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {}; // not signed in → magpie's standard handling

        return {
          baseURL: `${up.BASE}/v1`,
          apiKey: "anonymous",
          headers: {},
          // magpie sends POST {baseURL}/chat/completions with a JSON string
          // body here. Everything else is answered by magpie itself from
          // provider.models — we never see other paths.
          async fetch(input, init) {
            const url = typeof input === "string" ? input : input?.url ?? "";
            if (!url.endsWith("/chat/completions")) {
              return new Response(JSON.stringify({ error: { message: `unsupported path: ${url}`, type: "invalid_request_error" } }), { status: 404, headers: { "content-type": "application/json" } });
            }
            try {
              return await handleChat({
                body: typeof init?.body === "string"
                  ? init.body
                  : (init?.body ? new TextDecoder().decode(init.body) : init?.body),
                modelMap: MODEL_MAP,
                signal: init?.signal,
              });
            } catch (err) {
              // Last-resort envelope: handleChat maps its own errors; a throw
              // here means something outside that table.
              return errorResponse(502, err?.message ?? "upstream request failed");
            }
          },
        };
      },

      // No quota/credits exist upstream. Identity only, no network: a usage
      // hook that probes stalls the whole quota page. Routing-wise magpie
      // handles the failures itself: a 503/429 stream rests the account
      // through its own fallback machinery, so no windows are reported.
      async usage(getAuth) {
        const auth = await getAuth();
        if (!auth) return { error: "未启用" };
        return { user: "匿名会话" };
      },

      // No check-in activity exists upstream → the valid "inactive" outcome.
      async checkin() {
        return { outcome: "inactive", message: "该平台无签到活动（匿名按量免费）" };
      },
    },

    // Web search API (magpie's `search` hook): the search-lab pipeline behind
    // the same anonymous clearance + session the chat path uses, so a client's
    // own WebSearch is answered with real ranked pages. The run's grounded
    // synthesis is dropped at this boundary — plugin.SearchPage has no `text`
    // field — see the note in src/search.mjs.
    //
    // keyOptional — not `auth` — because there is no account to bind: the
    // clearance cookie and session token live in the module-level Client, and
    // `auth: "inceptionlab"` would make the host demand a signed-in account
    // and route the call through its refresh path for credentials this plugin
    // never stores. url/keysURL are absent for the same reason (no key, no
    // signup page).
    search: {
      inceptionlab: {
        name: "Inception Mercury",
        keyOptional: true,
        execute: (inputs, ctx) => searchInception(inputs, client, { signal: ctx?.abort }),
      },
    },

    // Static catalog: the upstream publishes no models endpoint. Never empty.
    provider: {
      id: PROVIDER,
      async models() {
        return { ...MODEL_ENTRIES };
      },
    },
  };
};

export const _internal = {
  PROVIDER, BASE: up.BASE, STATIC_MODELS, buildModelMap, handleChat, setClient, errorResponse,
  searchInception, collectSearch, buildSearchRequest, normalizeSources,
};
