import { describe, expect, test } from "bun:test";
import { ANTHROPIC_MODELS, CHAT_MODELS, RESPONSES_MODELS, modelsForLiveIds } from "./catalog.ts";
import { partitionModelIds } from "./docs-fetcher.ts";

describe("OpenAI Responses reasoning levels", () => {
  test.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
    "%s exposes native xhigh and max efforts",
    (id) => {
      const model = RESPONSES_MODELS.find((candidate) => candidate.id === id);

      expect(model).toBeDefined();
      expect(model?.contextWindow).toBe(372_000);
      expect(model?.thinkingLevelMap).toMatchObject({
        off: "none",
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      });
    },
  );

  test("older GPT models expose native off/xhigh without max", () => {
    const model = RESPONSES_MODELS.find((candidate) => candidate.id === "gpt-5.5");

    expect(model).toBeDefined();
    expect(model?.thinkingLevelMap.off).toBe("none");
    expect(model?.thinkingLevelMap.xhigh).toBe("xhigh");
    expect("max" in (model?.thinkingLevelMap ?? {})).toBe(false);
  });
});

describe("catalog compatibility", () => {
  test("Claude models use adaptive thinking and expose max", () => {
    for (const model of ANTHROPIC_MODELS) {
      expect(model.thinkingLevelMap.max).toBe("max");
      expect(model.compat?.forceAdaptiveThinking).toBe(true);
    }
  });

  test("chat families carry explicit replay/stream formats", () => {
    const deepseek = CHAT_MODELS.find((model) => model.id === "deepseek/deepseek-v4-pro");
    const zai = CHAT_MODELS.find((model) => model.id === "z-ai/glm-5.2");
    expect(deepseek?.compat).toMatchObject({
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
    });
    expect(zai?.compat).toMatchObject({ thinkingFormat: "zai", zaiToolStream: true });
  });
});

describe("live catalog", () => {
  const ids = [
    "anthropic/claude-sonnet-5",
    "openai/gpt-5.6-sol",
    "z-ai/glm-5.2",
    "minimax/minimax-m3",
    "minimax/minimax-future",
    "deepseek/deepseek-v4-pro",
  ];

  test("partitions every supported family", () => {
    expect(partitionModelIds(ids)).toEqual({
      anthropic: ["anthropic/claude-sonnet-5"],
      responses: ["openai/gpt-5.6-sol"],
      chat: ["deepseek/deepseek-v4-pro", "minimax/minimax-future", "minimax/minimax-m3", "openai/gpt-5.6-sol", "z-ai/glm-5.2"],
    });
  });

  test("openai/* IDs surface in the chat bucket with their static metadata", () => {
    const live = ["openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-5.6-luna", "openai/gpt-5.5", "openai/gpt-5.4", "openai/gpt-5.4-mini", "openai/gpt-5.3-codex-spark"];
    const chat = modelsForLiveIds("chat", live);
    const byId = Object.fromEntries(chat.map((m) => [m.id, m]));

    expect(byId["gpt-5.6-sol"].contextWindow).toBe(372_000);
    expect(byId["gpt-5.6-sol"].maxTokens).toBe(128_000);
    expect(byId["gpt-5.6-sol"].input).toEqual(["text", "image"]);
    expect(byId["gpt-5.6-sol"].thinkingLevelMap.max).toBe("max");
    expect(byId["gpt-5.6-sol"].thinkingLevelMap.xhigh).toBe("xhigh");
    expect(byId["gpt-5.6-sol"].compat.supportsReasoningEffort).toBe(true);

    expect(byId["gpt-5.5"].contextWindow).toBe(1_000_000);
    expect(byId["gpt-5.5"].thinkingLevelMap.max).toBeUndefined();
    expect(byId["gpt-5.5"].compat.supportsReasoningEffort).toBe(true);

    expect(byId["gpt-5.4"].contextWindow).toBe(1_050_000);
    expect(byId["gpt-5.4-mini"].contextWindow).toBe(400_000);
    expect(byId["gpt-5.3-codex-spark"].thinkingLevelMap.off).toBeNull();
  });

  test("preserves legacy short IDs for Claude and GPT", () => {
    expect(modelsForLiveIds("anthropic", [ids[0]])[0].id).toBe("claude-sonnet-5");
    expect(modelsForLiveIds("responses", [ids[1]])[0].id).toBe("gpt-5.6-sol");
    expect(modelsForLiveIds("chat", [ids[3]])[0].id).toBe("minimax/minimax-m3");
  });

  test("creates conservative metadata for future models", () => {
    const model = modelsForLiveIds("responses", ["openai/gpt-future"])[0];
    expect(model).toMatchObject({ id: "gpt-future", reasoning: true, contextWindow: 128_000 });
  });

  test("preserves family compatibility for future models", () => {
    const anthropic = modelsForLiveIds("anthropic", ["anthropic/claude-future"])[0];
    const zai = modelsForLiveIds("chat", ["z-ai/glm-future"])[0];
    const deepseek = modelsForLiveIds("chat", ["deepseek/deepseek-future"])[0];
    const minimax = modelsForLiveIds("chat", ["minimax/minimax-future"])[0];

    expect(anthropic.compat).toMatchObject({ forceAdaptiveThinking: true });
    expect(zai.compat).toMatchObject({ thinkingFormat: "zai", zaiToolStream: true });
    expect(deepseek.compat).toMatchObject({
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
    });
    expect(minimax.input).toEqual(["text", "image"]);
  });
});
