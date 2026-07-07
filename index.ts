// pi-openlimits — registers OpenLimits models as 3 Pi providers.
// That's it. No commands, no hooks, no doctor.
//
// Providers:
//   openlimits-claude -> /v1/messages        (Claude + Fable)
//   openlimits-codex     -> /v1/responses       (GPT)
//   openlimits           -> /v1/chat/completions (GLM, M3, DeepSeek)
//
// Harness fixes baked in:
//   - thinkingLevelMap.xhigh maps to ultracode/high/max per family
//   - compat.forceAdaptiveThinking + interleaved-thinking beta for Claude
//   - compat.reasoningSummary: "concise" so GPT reasoning summaries render
//   - compat.supportsStore/supportsDeveloperRole: false for Chat Completions

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ANTHROPIC_MODELS,
  RESPONSES_MODELS,
  CHAT_MODELS,
  ANTHROPIC_BASE,
  OPENAI_BASE,
} from "./catalog.ts";
import { resolveKey } from "./auth.ts";

export default function openlimitsPlugin(pi: ExtensionAPI): void {
  const { apiKey } = resolveKey();

  pi.registerProvider("openlimits-claude", {
    baseUrl: ANTHROPIC_BASE,
    api: "anthropic-messages",
    apiKey,
    headers: {
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    },
    compat: {
      supportsEagerToolInputStreaming: false,
      supportsLongCacheRetention: true,
      forceAdaptiveThinking: true,
    },
    models: ANTHROPIC_MODELS,
  });

  pi.registerProvider("openlimits-codex", {
    baseUrl: OPENAI_BASE,
    api: "openai-responses",
    apiKey,
    compat: {
      reasoningSummary: "concise",
    },
    models: RESPONSES_MODELS,
  });

  pi.registerProvider("openlimits", {
    baseUrl: OPENAI_BASE,
    api: "openai-completions",
    apiKey,
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
      supportsReasoningEffort: true,
    },
    models: CHAT_MODELS,
  });
}