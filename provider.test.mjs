import { afterEach, describe, expect, test } from "bun:test";
import openlimitsPlugin, { isOpenLimitsUpstreamRejection } from "./index.ts";
import { isRetryableAssistantError } from "./node_modules/@earendil-works/pi-ai/dist/utils/retry.js";
import { isContextOverflow } from "./node_modules/@earendil-works/pi-ai/dist/utils/overflow.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function loadProviders() {
  const providers = new Map();
  openlimitsPlugin({
    on: () => {},
    registerProvider: (id, config) => providers.set(id, config),
  });
  return providers;
}

function memoryStore(initial) {
  let entry = initial;
  return {
    async read() { return entry; },
    async write(value) { entry = value; },
    async delete() { entry = undefined; },
    value() { return entry; },
  };
}

describe("provider registration", () => {
  test("registers three refreshable providers with family-specific APIs", () => {
    const providers = loadProviders();
    expect([...providers.keys()]).toEqual(["openlimits-claude", "openlimits-codex", "openlimits"]);
    expect(providers.get("openlimits-claude")).toMatchObject({ api: "anthropic-messages" });
    expect(providers.get("openlimits-codex")).toMatchObject({ api: "openai-responses" });
    expect(providers.get("openlimits")).toMatchObject({ api: "openai-completions" });
    for (const provider of providers.values()) expect(provider.refreshModels).toBeFunction();
  });

  test("preserves aborted request semantics while waiting", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = loadProviders().get("openlimits");
    const events = [];
    for await (const event of provider.streamSimple(
      { api: "openai-completions", provider: "openlimits", id: "test-model" },
      { messages: [] },
      { signal: controller.signal },
    )) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", reason: "aborted", error: { stopReason: "aborted" } });
    expect(isRetryableAssistantError(events[0].error)).toBe(false);
  });

  test("forces mapped reasoning_effort into the final Chat Completions body", async () => {
    const bodies = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
			'data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"test","object":"chat.completion.chunk","created":0,"model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const provider = loadProviders().get("openlimits");
    const staleModel = {
      id: "gpt-test",
      name: "GPT test",
      api: "openai-completions",
      provider: "openlimits",
      baseUrl: "https://openlimits.app/v1",
      reasoning: true,
      thinkingLevelMap: { low: "low", max: "max" },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
      // Deliberately stale: pi-ai would otherwise omit reasoning_effort.
      compat: { supportsReasoningEffort: false },
    };

    for await (const _event of provider.streamSimple(
      staleModel,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
      {
        apiKey: "test-key",
        reasoning: "low",
        onPayload: (payload) => ({ ...payload, user_callback_preserved: true }),
      },
    )) {}

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      reasoning_effort: "low",
      user_callback_preserved: true,
    });
  });

  test("deduplicates live fetches and persists provider-scoped catalogs", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({
        object: "list",
        data: [
          { id: "anthropic/claude-sonnet-5", object: "model" },
          { id: "openai/gpt-5.6-sol", object: "model" },
          { id: "z-ai/glm-5.2", object: "model" },
          { id: "minimax/minimax-m3", object: "model" },
        ],
      });
    };

    const providers = loadProviders();
    const stores = new Map([...providers.keys()].map((id) => [id, memoryStore()]));
    await Promise.all([...providers].map(([id, provider]) => provider.refreshModels({
      credential: { type: "api_key", key: "sk-ol-test" },
      store: stores.get(id),
      allowNetwork: true,
      force: true,
    })));

    expect(calls).toBe(1);
    expect(stores.get("openlimits-claude").value().models[0]).toMatchObject({
      provider: "openlimits-claude", api: "anthropic-messages", id: "claude-sonnet-5",
    });
    expect(stores.get("openlimits-codex").value().models[0]).toMatchObject({
      provider: "openlimits-codex", api: "openai-responses", id: "gpt-5.6-sol",
    });
    const chatModels = stores.get("openlimits").value().models;
    expect([...chatModels.map((model) => model.id)].sort()).toEqual([
      "gpt-5.6-sol", "minimax/minimax-m3", "z-ai/glm-5.2",
    ]);
    expect(chatModels.find((model) => model.id === "gpt-5.6-sol").compat).toMatchObject({
      maxTokensField: "max_completion_tokens",
      supportsReasoningEffort: true,
    });
  });

  test("supports Pi 0.84 stored snapshots and transactional publication", async () => {
    globalThis.fetch = async () => Response.json({
      object: "list",
      data: [{ id: "openai/gpt-5.6-sol", object: "model" }],
    });

    const publications = [];
    const provider = loadProviders().get("openlimits-codex");
    const models = await provider.refreshModels({
      credential: { type: "api_key", key: "sk-ol-test" },
      stored: { checkedAt: 0, models: [] },
      publish: async (publication) => {
        publications.push(publication);
        return true;
      },
      allowNetwork: true,
      force: true,
      signal: new AbortController().signal,
    });

    expect(models.map((model) => model.id)).toEqual(["gpt-5.6-sol"]);
    expect(publications).toHaveLength(1);
    expect(publications[0].persist).toMatchObject({
      models: [{ provider: "openlimits-codex", api: "openai-responses", id: "gpt-5.6-sol" }],
    });
  });

  test("normalizes cached GPT Chat Completions compat without network access", async () => {
    const provider = loadProviders().get("openlimits");
    const cached = {
      checkedAt: Date.now(),
      models: [{
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol (OpenLimits)",
        api: "openai-completions",
        provider: "openlimits",
        baseUrl: "https://openlimits.app/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 372_000,
        maxTokens: 128_000,
        compat: { supportsToolSearch: true },
      }],
    };
    const models = await provider.refreshModels({ store: memoryStore(cached), allowNetwork: false });

    expect(models[0].compat).toMatchObject({
      maxTokensField: "max_completion_tokens",
      supportsReasoningEffort: true,
    });
    expect(models[0].compat.supportsToolSearch).toBeUndefined();
  });

  test("uses a fresh persisted catalog without network access", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error("fetch should not run");
    };
    const provider = loadProviders().get("openlimits-codex");
    const cached = {
      checkedAt: Date.now(),
      models: [{
        id: "gpt-cached",
        name: "GPT Cached",
        api: "openai-responses",
        provider: "openlimits-codex",
        baseUrl: "https://openlimits.app/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 32_000,
      }],
    };
    const models = await provider.refreshModels({
      store: memoryStore(cached),
      allowNetwork: true,
      force: false,
    });

    expect(calls).toBe(0);
    expect(models[0]).toMatchObject({ id: "gpt-cached", api: "openai-responses" });
    expect("provider" in models[0]).toBe(false);
  });
});

describe("upstream 400 recovery", () => {
  const upstreamError = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "OpenAI API error (400): {\"message\":\"The upstream provider rejected the request.\"}",
  };

  test("recognizes only the generic OpenLimits upstream rejection", () => {
    expect(isOpenLimitsUpstreamRejection(upstreamError)).toBe(true);
    expect(isOpenLimitsUpstreamRejection({ ...upstreamError, errorMessage: "OpenAI API error (429)" })).toBe(false);
    expect(isOpenLimitsUpstreamRejection({ ...upstreamError, stopReason: "stop" })).toBe(false);
  });

  test("classifies the first rejection then leaves a failed compact retry visible", () => {
    const handlers = new Map();
    openlimitsPlugin({
      on: (event, handler) => handlers.set(event, handler),
      registerProvider: () => {},
    });
    const ctx = { model: { provider: "openlimits-codex" } };
    const messageEnd = handlers.get("message_end");

    const first = messageEnd({ message: upstreamError }, ctx).message;
    expect(isContextOverflow(first, 372_000)).toBe(true);
    expect(isRetryableAssistantError(first)).toBe(false);

    handlers.get("session_before_compact")({ reason: "overflow", willRetry: true }, ctx);
    const checkpoint = {
      role: "user",
      content: [{ type: "input_text", text: '<pi_goal_continuation kind="checkpoint">GOAL CHECKPOINT' }],
    };
    const sanitized = handlers.get("before_provider_request")({
      payload: {
        input: [
          checkpoint,
          { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] },
          checkpoint,
        ],
      },
    }, ctx);
    expect(sanitized.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "[Historical image omitted while generating an automatic compaction summary]" }] },
      checkpoint,
    ]);

    expect(messageEnd({ message: upstreamError }, ctx)).toBeUndefined();
  });

  test("keeps only the final overflow error after native compaction", () => {
    const handlers = new Map();
    openlimitsPlugin({
      on: (event, handler) => handlers.set(event, handler),
      registerProvider: () => {},
    });
    const ctx = { model: { provider: "openlimits-codex" } };
    const messageEnd = handlers.get("message_end");
    const overflowMessage = messageEnd({ message: upstreamError }, ctx).message;
    const preparation = { firstKeptEntryId: "old-kept-entry" };
    const branchEntries = [
      {
        id: "old-kept-entry",
        type: "message",
        message: { role: "assistant", stopReason: "toolUse", content: [] },
      },
      { id: "final-overflow", type: "message", message: overflowMessage },
    ];

    handlers.get("session_before_compact")({
      reason: "overflow",
      willRetry: true,
      preparation,
      branchEntries,
    }, ctx);

    expect(preparation.firstKeptEntryId).toBe("final-overflow");
  });

  test("aligns a native context-window error after an OpenLimits rejection", () => {
    const handlers = new Map();
    openlimitsPlugin({
      on: (event, handler) => handlers.set(event, handler),
      registerProvider: () => {},
    });
    const ctx = { model: { provider: "openlimits-codex" } };
    const messageEnd = handlers.get("message_end");
    messageEnd({ message: upstreamError }, ctx);
    messageEnd({ message: upstreamError }, ctx);
    const overflowMessage = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Your input exceeds the context window of this model. Please adjust your input and try again.",
    };
    const preparation = { firstKeptEntryId: "old-kept-entry" };
    const branchEntries = [
      { id: "old-kept-entry", type: "message", message: { role: "assistant", stopReason: "toolUse", content: [] } },
      { id: "final-overflow", type: "message", message: overflowMessage },
    ];

    handlers.get("session_before_compact")({
      reason: "overflow",
      willRetry: true,
      preparation,
      branchEntries,
    }, ctx);

    expect(preparation.firstKeptEntryId).toBe("final-overflow");
  });

  test("applies overflow recovery to the Chat Completions OpenLimits provider", () => {
    const handlers = new Map();
    openlimitsPlugin({
      on: (event, handler) => handlers.set(event, handler),
      registerProvider: () => {},
    });
    const ctx = { model: { provider: "openlimits" } };
    const messageEnd = handlers.get("message_end");
    const classified = messageEnd({ message: upstreamError }, ctx).message;
    expect(isContextOverflow(classified, 372_000)).toBe(true);

    const preparation = { firstKeptEntryId: "old-kept-entry" };
    handlers.get("session_before_compact")({
      reason: "overflow",
      willRetry: true,
      preparation,
      branchEntries: [
        { id: "old-kept-entry", type: "message", message: { role: "user", content: [] } },
        { id: "final-overflow", type: "message", message: classified },
      ],
    }, ctx);

    expect(preparation.firstKeptEntryId).toBe("final-overflow");
  });

  test("a non-error assistant response permits a fresh first classification", () => {
    const handlers = new Map();
    openlimitsPlugin({
      on: (event, handler) => handlers.set(event, handler),
      registerProvider: () => {},
    });
    const ctx = { model: { provider: "openlimits-codex" } };
    const messageEnd = handlers.get("message_end");

    messageEnd({ message: upstreamError }, ctx);
    messageEnd({ message: { role: "assistant", stopReason: "stop" } }, ctx);
    const firstAfterReset = messageEnd({ message: upstreamError }, ctx).message;
    expect(isContextOverflow(firstAfterReset, 372_000)).toBe(true);
    expect(isRetryableAssistantError(firstAfterReset)).toBe(false);
    expect(messageEnd({ message: upstreamError }, ctx)).toBeUndefined();
  });
});
