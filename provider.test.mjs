import { afterEach, describe, expect, test } from "bun:test";
import openlimitsPlugin from "./index.ts";

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
