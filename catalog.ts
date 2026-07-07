// Static catalog of OpenLimits models.
// Claude and Codex provider IDs intentionally omit upstream family prefixes.

export const ANTHROPIC_BASE = "https://openlimits.app";
export const OPENAI_BASE = "https://openlimits.app/v1";

const ANTHROPIC_TLM = {
  off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "ultracode",
} as const;

const RESPONSES_TLM = {
  off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high",
} as const;

const CHAT_TLM = {
  off: null, minimal: null, low: "high", medium: "high", high: "high", xhigh: "max",
} as const;

export const ANTHROPIC_MODELS = [
  { id: "claude-opus-4.8", name: "Claude Opus 4.8 (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...ANTHROPIC_TLM }, compat: { supportsTemperature: false } },
  { id: "claude-opus-4.7", name: "Claude Opus 4.7 (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...ANTHROPIC_TLM }, compat: { supportsTemperature: false } },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5 (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...ANTHROPIC_TLM } },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5 (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 200_000, maxTokens: 64_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...ANTHROPIC_TLM } },
  { id: "fable-5", name: "Fable 5 (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...ANTHROPIC_TLM } },
];

export const RESPONSES_MODELS = [
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...RESPONSES_TLM }, compat: { reasoningSummary: "concise" } },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...RESPONSES_TLM }, compat: { reasoningSummary: "concise" } },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...RESPONSES_TLM }, compat: { reasoningSummary: "concise" } },
  { id: "gpt-5.5", name: "GPT-5.5 (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...RESPONSES_TLM }, compat: { reasoningSummary: "concise" } },
  { id: "gpt-5.4", name: "GPT-5.4 (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 1_050_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...RESPONSES_TLM }, compat: { reasoningSummary: "concise" } },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 400_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...RESPONSES_TLM }, compat: { reasoningSummary: "concise" } },
  { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark (OpenLimits)", reasoning: true,
    input: ["text", "image"], contextWindow: 128_000, maxTokens: 32_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...RESPONSES_TLM, off: null }, compat: { reasoningSummary: "concise" } },
];

export const CHAT_MODELS = [
  { id: "z-ai/glm-5.2", name: "GLM 5.2 (OpenLimits)", reasoning: true,
    input: ["text"], contextWindow: 1_000_000, maxTokens: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...CHAT_TLM } },
  { id: "z-ai/glm-5.1", name: "GLM 5.1 (OpenLimits)", reasoning: true,
    input: ["text"], contextWindow: 202_000, maxTokens: 202_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...CHAT_TLM } },
  { id: "z-ai/glm-5-turbo", name: "GLM 5 Turbo (OpenLimits)", reasoning: true,
    input: ["text"], contextWindow: 202_800, maxTokens: 131_100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...CHAT_TLM } },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro (OpenLimits)", reasoning: true,
    input: ["text"], contextWindow: 1_000_000, maxTokens: 384_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...CHAT_TLM } },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (OpenLimits)", reasoning: true,
    input: ["text"], contextWindow: 1_000_000, maxTokens: 384_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { ...CHAT_TLM } },
];

export const ALL_MODEL_IDS = [
  ...ANTHROPIC_MODELS.map((m) => m.id),
  ...RESPONSES_MODELS.map((m) => m.id),
  ...CHAT_MODELS.map((m) => m.id),
];
