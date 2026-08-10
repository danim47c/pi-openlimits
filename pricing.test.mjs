import { describe, expect, test } from "bun:test";
import { calculateCost } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { CHAT_MODELS, RESPONSES_MODELS, modelsForLiveIds } from "./catalog.ts";
import { DEFAULT_PRICING, resolveModelPricing } from "./pricing.ts";

describe("OpenLimits model pricing", () => {
  test("static catalog models expose non-zero upstream estimates", () => {
    for (const model of [...RESPONSES_MODELS, ...CHAT_MODELS]) {
      expect(model.cost.input + model.cost.output).toBeGreaterThan(0);
    }
    expect(RESPONSES_MODELS.find((model) => model.id === "gpt-5.6-sol")?.cost).toMatchObject({
      input: 5,
      output: 30,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
    expect(CHAT_MODELS.find((model) => model.id === "z-ai/glm-5.2")?.cost).toMatchObject({
      input: 1.4,
      output: 4.4,
      cacheRead: 0.26,
    });
  });

  test("uses cache read/write rates and applies large-context tiers", () => {
    const model = RESPONSES_MODELS.find((candidate) => candidate.id === "gpt-5.6-sol");
    const usage = {
      input: 300_000,
      output: 100_000,
      cacheRead: 20_000,
      cacheWrite: 10_000,
      totalTokens: 430_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    calculateCost(model, usage);

    // 300k + 20k + 10k crosses the 272k request tier. Rates are USD/MTok.
    expect(usage.cost.input).toBeCloseTo(3, 10);
    expect(usage.cost.output).toBeCloseTo(4.5, 10);
    expect(usage.cost.cacheRead).toBeCloseTo(0.02, 10);
    expect(usage.cost.cacheWrite).toBeCloseTo(0.125, 10);
    expect(usage.cost.total).toBeCloseTo(7.645, 10);
  });

  test("pi-ai reports the calculated cost from a streamed usage block", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      'data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n' +
      'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":250}}}\n\n' +
      "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
    try {
      const base = RESPONSES_MODELS.find((candidate) => candidate.id === "gpt-5.6-sol");
      const model = {
        ...base,
        api: "openai-completions",
        provider: "openlimits",
        baseUrl: "https://example.test/v1",
      };
      let usage;
      for await (const event of openAICompletionsApi().streamSimple(
        model,
        { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
        { apiKey: "test-key" },
      )) {
        if (event.type === "done") usage = event.message.usage;
      }
      expect(usage.input).toBe(750);
      expect(usage.cacheRead).toBe(250);
      expect(usage.cost.total).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("prices live prefixed ids and keeps a non-zero future fallback", () => {
    expect(resolveModelPricing("openai/gpt-5.6-terra", "responses").input).toBe(2.5);
    expect(resolveModelPricing("anthropic/claude-opus-4.8", "anthropic").output).toBe(25);
    expect(modelsForLiveIds("responses", ["openai/gpt-future"])[0].cost.input).toBeGreaterThan(0);
    expect(DEFAULT_PRICING["openai/gpt-5.6-sol"]).toBeDefined();
  });
});
