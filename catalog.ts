// Static catalog of OpenLimits models.
// Claude and Codex provider IDs intentionally omit upstream family prefixes.

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { loadPricingOverrides, resolveModelPricing, type PricingFamily } from "./pricing.ts";

export const ANTHROPIC_BASE = "https://openlimits.app";
export const OPENAI_BASE = "https://openlimits.app/v1";

const ANTHROPIC_TLM = {
  off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "ultracode", max: "max",
} as const;

const RESPONSES_TLM = {
  off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh",
} as const;

// GPT-5.6 adds native xhigh and max efforts. Keep this separate from older
// Responses models, where OpenLimits currently tops out at high.
const GPT_56_RESPONSES_TLM = {
  ...RESPONSES_TLM, xhigh: "xhigh", max: "max",
} as const;

const CHAT_TLM = {
  off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
} as const;

const GPT_56_CHAT_TLM = CHAT_TLM;

const ZAI_TLM = {
  off: null, minimal: null, low: "high", medium: "high", high: "high", max: "max",
} as const;

const RESPONSES_COMPAT = { supportsToolSearch: true } as const;
// OpenLimits' Chat Completions route can close a successful SSE stream without
// a final `finish_reason`. Pi 0.84's compat flag makes pi-ai infer `stop` or
// `toolUse` from the assembled content instead of reporting truncation.
type ChatCompat = NonNullable<ProviderModelConfig["compat"]> & {
  supportsFinishReason?: boolean;
};
const CHAT_COMPAT: ChatCompat = {
  supportsDeveloperRole: false,
  supportsStore: false,
  supportsFinishReason: false,
  maxTokensField: "max_tokens",
};
const ZAI_COMPAT = { ...CHAT_COMPAT, supportsReasoningEffort: true, thinkingFormat: "zai", zaiToolStream: true } as const;
const DEEPSEEK_COMPAT = {
  ...CHAT_COMPAT,
  supportsReasoningEffort: true,
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
} as const;
const GPT_CHAT_COMPAT = {
  ...CHAT_COMPAT,
  maxTokensField: "max_completion_tokens",
  supportsReasoningEffort: true,
  requiresReasoningContentOnAssistantMessages: true,
} as const;
const ANTHROPIC_COMPAT = {
  supportsEagerToolInputStreaming: false,
  supportsLongCacheRetention: true,
  forceAdaptiveThinking: true,
} as const;

export const ANTHROPIC_MODELS = [
  { id: "claude-opus-5", name: "Claude Opus 5 (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...ANTHROPIC_TLM }, compat: { ...ANTHROPIC_COMPAT, supportsTemperature: false } },
  { id: "claude-opus-4.8", name: "Claude Opus 4.8 (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...ANTHROPIC_TLM }, compat: { ...ANTHROPIC_COMPAT, supportsTemperature: false } },
  { id: "claude-opus-4.7", name: "Claude Opus 4.7 (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...ANTHROPIC_TLM }, compat: { ...ANTHROPIC_COMPAT, supportsTemperature: false } },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5 (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...ANTHROPIC_TLM }, compat: { ...ANTHROPIC_COMPAT } },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5 (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 200_000, maxTokens: 64_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...ANTHROPIC_TLM }, compat: { ...ANTHROPIC_COMPAT } },
  { id: "fable-5", name: "Fable 5 (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...ANTHROPIC_TLM }, compat: { ...ANTHROPIC_COMPAT } },
] satisfies ProviderModelConfig[];

// OpenLimits accepts approximately 920K input tokens for GPT-5.6 and
// rejects requests above the documented 922K input ceiling. With the 128K
// output budget, that is the published 1.05M total context window.
export const RESPONSES_MODELS = [
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_050_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...GPT_56_RESPONSES_TLM }, compat: { ...RESPONSES_COMPAT } },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_050_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...GPT_56_RESPONSES_TLM }, compat: { ...RESPONSES_COMPAT } },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_050_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...GPT_56_RESPONSES_TLM }, compat: { ...RESPONSES_COMPAT } },
  { id: "gpt-5.5", name: "GPT-5.5 (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...RESPONSES_TLM }, compat: { ...RESPONSES_COMPAT } },
  { id: "gpt-5.4", name: "GPT-5.4 (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_050_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...RESPONSES_TLM }, compat: { ...RESPONSES_COMPAT } },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 400_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...RESPONSES_TLM }, compat: { ...RESPONSES_COMPAT } },
  { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 128_000, maxTokens: 32_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...RESPONSES_TLM, off: null }, compat: { ...RESPONSES_COMPAT } },
] satisfies ProviderModelConfig[];

// Chat Completions needs different compat from Responses for the same GPT IDs.
// Keep this derived list as the single source for the openlimits provider.
export const GPT_CHAT_MODELS = RESPONSES_MODELS.map((model) => ({
  ...model,
  compat: { ...GPT_CHAT_COMPAT },
})) satisfies ProviderModelConfig[];

export const CHAT_MODELS = [
  { id: "z-ai/glm-5.2", name: "GLM 5.2 (OpenLimits)", reasoning: true,
    input: ["text"], contextWindow: 1_000_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...ZAI_TLM }, compat: { ...ZAI_COMPAT } },
  { id: "z-ai/glm-5.1", name: "GLM 5.1 (OpenLimits)", reasoning: true,
    input: ["text"], contextWindow: 202_000, maxTokens: 202_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...ZAI_TLM }, compat: { ...ZAI_COMPAT } },
  { id: "z-ai/glm-5-turbo", name: "GLM 5 Turbo (OpenLimits)", reasoning: true,
    input: ["text"], contextWindow: 202_800, maxTokens: 131_100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...ZAI_TLM }, compat: { ...ZAI_COMPAT } },
  { id: "minimax/minimax-m3", name: "MiniMax M3 (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 524_288, maxTokens: 512_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...CHAT_TLM }, compat: { ...CHAT_COMPAT } },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro (OpenLimits)", reasoning: true,
    input: ["text"], contextWindow: 1_000_000, maxTokens: 384_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...CHAT_TLM }, compat: { ...DEEPSEEK_COMPAT } },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (OpenLimits)", reasoning: true,
    input: ["text"], contextWindow: 1_000_000, maxTokens: 384_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...CHAT_TLM }, compat: { ...DEEPSEEK_COMPAT } },
] satisfies ProviderModelConfig[];

export const OPENLIMITS_CHAT_MODELS = [...CHAT_MODELS, ...GPT_CHAT_MODELS] satisfies ProviderModelConfig[];

// Keep all static models priced as soon as the extension is loaded. This is
// what pi-ai's calculateCost(model, usage) reads when it finalizes a stream.
// The override file is optional; models.dev-derived rates remain the default.
const PRICING_OVERRIDES = loadPricingOverrides();
function attachPricing(models: ProviderModelConfig[], family: PricingFamily): void {
  for (const model of models) {
    model.cost = resolveModelPricing(model.id, family, PRICING_OVERRIDES);
  }
}

attachPricing(ANTHROPIC_MODELS, "anthropic");
attachPricing(RESPONSES_MODELS, "responses");
attachPricing(CHAT_MODELS, "chat");
attachPricing(GPT_CHAT_MODELS, "chat");

type CatalogFamily = "anthropic" | "responses" | "chat";

const FAMILY_DEFAULTS: Record<CatalogFamily, Omit<ProviderModelConfig, "id" | "name" | "cost">> = {
  anthropic: {
    reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 64_000,
    thinkingLevelMap: ANTHROPIC_TLM, compat: ANTHROPIC_COMPAT,
  },
  responses: {
    reasoning: true, input: ["text", "image"], contextWindow: 128_000, maxTokens: 32_000,
    thinkingLevelMap: RESPONSES_TLM, compat: RESPONSES_COMPAT,
  },
  chat: {
    reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 32_000,
    thinkingLevelMap: CHAT_TLM, compat: CHAT_COMPAT,
  },
};

function defaultsForLiveId(family: CatalogFamily, id: string): Omit<ProviderModelConfig, "id" | "name" | "cost"> {
  if (family !== "chat") return FAMILY_DEFAULTS[family];
  if (id.startsWith("z-ai/")) {
    return { ...FAMILY_DEFAULTS.chat, thinkingLevelMap: ZAI_TLM, compat: ZAI_COMPAT };
  }
  if (id.startsWith("deepseek/")) {
    return { ...FAMILY_DEFAULTS.chat, thinkingLevelMap: CHAT_TLM, compat: DEEPSEEK_COMPAT };
  }
  if (id.startsWith("minimax/")) {
    return { ...FAMILY_DEFAULTS.chat, input: ["text", "image"] };
  }
  if (id.startsWith("openai/")) {
    const short = id.slice("openai/".length);
    // OpenAI-style completions for the GPT family: emit reasoning_effort at
    // top level (default compat branch in pi-ai), use max_completion_tokens,
    // and force reasoning_content replay so multi-turn thinking stays wired.
    if (short.startsWith("gpt-5.6-")) {
      return {
        ...FAMILY_DEFAULTS.chat,
        input: ["text", "image"],
        contextWindow: 372_000,
        maxTokens: 128_000,
        thinkingLevelMap: GPT_56_CHAT_TLM,
        compat: GPT_CHAT_COMPAT,
      };
    }
    if (short === "gpt-5.5") {
      return {
        ...FAMILY_DEFAULTS.chat,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        thinkingLevelMap: { ...RESPONSES_TLM },
        compat: GPT_CHAT_COMPAT,
      };
    }
    if (short === "gpt-5.4") {
      return {
        ...FAMILY_DEFAULTS.chat,
        input: ["text", "image"],
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        thinkingLevelMap: { ...RESPONSES_TLM },
        compat: GPT_CHAT_COMPAT,
      };
    }
    if (short === "gpt-5.4-mini") {
      return {
        ...FAMILY_DEFAULTS.chat,
        input: ["text", "image"],
        contextWindow: 400_000,
        maxTokens: 128_000,
        thinkingLevelMap: { ...RESPONSES_TLM },
        compat: GPT_CHAT_COMPAT,
      };
    }
    if (short === "gpt-5.3-codex-spark") {
      return {
        ...FAMILY_DEFAULTS.chat,
        input: ["text", "image"],
        contextWindow: 128_000,
        maxTokens: 32_000,
        thinkingLevelMap: { ...RESPONSES_TLM, off: null },
        compat: GPT_CHAT_COMPAT,
      };
    }
    return { ...FAMILY_DEFAULTS.chat, thinkingLevelMap: RESPONSES_TLM, compat: GPT_CHAT_COMPAT };
  }
  return FAMILY_DEFAULTS.chat;
}

export function modelsForLiveIds(family: CatalogFamily, liveIds: string[]): ProviderModelConfig[] {
  const staticModels: ProviderModelConfig[] = family === "anthropic"
    ? ANTHROPIC_MODELS
    : family === "responses"
      ? RESPONSES_MODELS
      : OPENLIMITS_CHAT_MODELS;
  const pricingOverrides = loadPricingOverrides();
  return liveIds.map((liveId) => {
    let id = liveId;
    if (id.startsWith("openai/")) id = id.slice("openai/".length);
    else if (id.startsWith("anthropic/")) id = id.slice("anthropic/".length);
    const known = staticModels.find((model) => model.id === id);
    if (known) return { ...known, cost: resolveModelPricing(liveId, family, pricingOverrides) };
    const label = id.split("/").slice(-1)[0]?.replaceAll("-", " ") ?? id;
    return {
      id,
      name: `${label.replace(/\b\w/g, (char) => char.toUpperCase())} (OpenLimits)`,
      ...defaultsForLiveId(family, id),
      cost: resolveModelPricing(liveId, family, pricingOverrides),
    };
  });
}

export const ALL_MODEL_IDS = [
  ...ANTHROPIC_MODELS.map((m) => m.id),
  ...RESPONSES_MODELS.map((m) => m.id),
  ...CHAT_MODELS.map((m) => m.id),
];
