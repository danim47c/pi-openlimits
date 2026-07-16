import { afterEach, describe, expect, test } from "bun:test";
import openlimitsPlugin, { isOpenLimitsUpstreamRejection } from "./index.ts";

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
    expect(stores.get("openlimits").value().models.map((model) => model.id)).toEqual([
      "minimax/minimax-m3", "z-ai/glm-5.2",
    ]);
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

  test("compacts once after 3 consecutive rejections and does not loop", () => {
    const handlers = new Map();
    const compactions = [];
    const sent = [];
    openlimitsPlugin({
      on: (event, handler) => handlers.set(event, handler),
      registerProvider: () => {},
      sendMessage: (message, options) => sent.push({ message, options }),
    });
    const ctx = {
      model: { provider: "openlimits-codex" },
      ui: { notify: () => {} },
      abort: () => { throw new Error("message_end recovery must not abort an ended request"); },
      compact: (options) => compactions.push(options),
    };
    const messageEnd = handlers.get("message_end");

    messageEnd({ message: upstreamError }, ctx);
    messageEnd({ message: upstreamError }, ctx);
    expect(compactions).toHaveLength(0);
    expect(sent).toHaveLength(2);
    expect(sent.every(({ message, options }) => message.display === false && options.triggerTurn === true)).toBe(true);
    messageEnd({ message: upstreamError }, ctx);
    expect(compactions).toHaveLength(1);

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

    compactions[0].onComplete();
    expect(sent).toHaveLength(3);
    messageEnd({ message: upstreamError }, ctx);
    messageEnd({ message: upstreamError }, ctx);
    messageEnd({ message: upstreamError }, ctx);
    expect(compactions).toHaveLength(1);
    expect(sent).toHaveLength(3);
  });

  test("a non-error assistant response breaks the consecutive streak", () => {
    const handlers = new Map();
    const compactions = [];
    openlimitsPlugin({
      on: (event, handler) => handlers.set(event, handler),
      registerProvider: () => {},
      sendMessage: () => {},
    });
    const ctx = {
      model: { provider: "openlimits-codex" },
      ui: { notify: () => {} },
      abort: () => {},
      compact: (options) => compactions.push(options),
    };
    const messageEnd = handlers.get("message_end");

    messageEnd({ message: upstreamError }, ctx);
    messageEnd({ message: { role: "assistant", stopReason: "stop" } }, ctx);
    messageEnd({ message: upstreamError }, ctx);
    messageEnd({ message: upstreamError }, ctx);
    expect(compactions).toHaveLength(0);
  });
});
