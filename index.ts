// pi-openlimits — registers OpenLimits models as 3 Pi providers.
// That's it. No commands, no hooks, no doctor.
//
// Providers:
//   openlimits-claude -> /v1/messages        (Claude + Fable)
//   openlimits-codex     -> /v1/responses       (GPT)
//   openlimits           -> /v1/chat/completions (GLM, M3, DeepSeek)
//
// Harness fixes baked in:
//   - GPT models expose native off/xhigh and GPT-5.6 adds max
//   - compat.forceAdaptiveThinking + interleaved-thinking beta for Claude
//   - OpenAI Responses reasoning summaries and deferred tool search
//   - compat.supportsStore/supportsDeveloperRole: false for Chat Completions

import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
  ANTHROPIC_MODELS,
  RESPONSES_MODELS,
  CHAT_MODELS,
  ANTHROPIC_BASE,
  OPENAI_BASE,
  modelsForLiveIds,
} from "./catalog.ts";
import { resolveKey } from "./auth.ts";
import { fetchLiveCatalog, type LiveCatalog } from "./docs-fetcher.ts";
import { preparePayloadForCompaction } from "./payload-guard.ts";

type CatalogKey = keyof LiveCatalog;
const CATALOG_TTL_MS = 4 * 60 * 60 * 1_000;
const UPSTREAM_400_COMPACTION_COUNT = 3;

export function isOpenLimitsUpstreamRejection(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
  return candidate.role === "assistant"
    && candidate.stopReason === "error"
    && typeof candidate.errorMessage === "string"
    && candidate.errorMessage.includes("OpenAI API error (400)")
    && candidate.errorMessage.includes("The upstream provider rejected the request.");
}

export default function openlimitsPlugin(pi: ExtensionAPI): void {
  const { apiKey } = resolveKey();
  let inFlightCatalog: Promise<LiveCatalog> | undefined;
  let consecutiveUpstreamRejections = 0;
  let errorRecoveryAttempted = false;
  let sanitizeNextCompactionRequest = false;

  pi.on("session_start", () => {
    consecutiveUpstreamRejections = 0;
    errorRecoveryAttempted = false;
    sanitizeNextCompactionRequest = false;
  });

  pi.on("session_before_compact", (_event, ctx) => {
    if (ctx.model?.provider === "openlimits-codex") sanitizeNextCompactionRequest = true;
  });

  pi.on("session_compact", (_event, ctx) => {
    if (ctx.model?.provider !== "openlimits-codex") return;
    consecutiveUpstreamRejections = 0;
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openlimits-codex") return;

    if (sanitizeNextCompactionRequest) {
      sanitizeNextCompactionRequest = false;
      return preparePayloadForCompaction(event.payload);
    }

  });

  pi.on("message_end", (event, ctx) => {
    if (ctx.model?.provider !== "openlimits-codex") return;
    const message = event.message as {
      role?: unknown;
      stopReason?: unknown;
      errorMessage?: unknown;
    };

    if (!isOpenLimitsUpstreamRejection(message)) {
      if (message.role === "assistant" && message.stopReason !== "error") {
        consecutiveUpstreamRejections = 0;
        errorRecoveryAttempted = false;
      }
      return;
    }

    // Native Pi owns retry, compaction, continuation, and the one-recovery cap.
    // We only classify OpenLimits' otherwise-generic 400: the first two are
    // transient retries; the third is an overflow.
    if (errorRecoveryAttempted) return;
    consecutiveUpstreamRejections += 1;
    const shouldCompact = consecutiveUpstreamRejections >= UPSTREAM_400_COMPACTION_COUNT;

    if (shouldCompact) {
      errorRecoveryAttempted = true;
      return {
        message: {
          ...event.message,
          errorMessage:
            `Your input exceeds the context window of this model. OpenLimits recovery classification: ${message.errorMessage}`,
        },
      };
    }

    return {
      message: {
        ...event.message,
        errorMessage: `${message.errorMessage} You can retry your request.`,
      },
    };
  });

  const refresh = (
    family: CatalogKey,
    staticModels: ProviderModelConfig[],
    provider: string,
    api: "anthropic-messages" | "openai-responses" | "openai-completions",
    baseUrl: string,
  ): NonNullable<ProviderConfig["refreshModels"]> => async (context) => {
    const cached = await context.store.read();
    const cachedModels = cached?.models.map(({ provider: _provider, ...model }) => model as ProviderModelConfig);
    if (!context.allowNetwork) return cachedModels ?? staticModels;
    if (!context.force && cached?.checkedAt && Date.now() - cached.checkedAt < CATALOG_TTL_MS) {
      return cachedModels ?? staticModels;
    }
    const key = context.credential?.type === "api_key" ? context.credential.key : apiKey;
    if (!key) return cachedModels ?? staticModels;
    inFlightCatalog ??= fetchLiveCatalog(key, context.signal).finally(() => {
      inFlightCatalog = undefined;
    });
    const catalog = await inFlightCatalog;
    const models = catalog[family].length > 0 ? modelsForLiveIds(family, catalog[family]) : staticModels;
    await context.store.write({
      checkedAt: Date.now(),
      models: models.map((model) => ({
        ...model,
        provider,
        api: model.api ?? api,
        baseUrl: model.baseUrl ?? baseUrl,
      })),
    });
    return models;
  };

  pi.registerProvider("openlimits-claude", {
    name: "OpenLimits Claude",
    baseUrl: ANTHROPIC_BASE,
    api: "anthropic-messages",
    apiKey,
    headers: {
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    },
    models: ANTHROPIC_MODELS,
    refreshModels: refresh("anthropic", ANTHROPIC_MODELS, "openlimits-claude", "anthropic-messages", ANTHROPIC_BASE),
  });

  pi.registerProvider("openlimits-codex", {
    name: "OpenLimits GPT/Codex",
    baseUrl: OPENAI_BASE,
    api: "openai-responses",
    apiKey,
    models: RESPONSES_MODELS,
    refreshModels: refresh("responses", RESPONSES_MODELS, "openlimits-codex", "openai-responses", OPENAI_BASE),
  });

  pi.registerProvider("openlimits", {
    name: "OpenLimits",
    baseUrl: OPENAI_BASE,
    api: "openai-completions",
    apiKey,
    models: [...CHAT_MODELS, ...RESPONSES_MODELS],
    refreshModels: refresh("chat", [...CHAT_MODELS, ...RESPONSES_MODELS], "openlimits", "openai-completions", OPENAI_BASE),
  });
}
