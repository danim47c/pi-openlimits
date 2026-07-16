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
import {
  countEmbeddedImages,
  measureImageHeavyPayload,
  preparePayloadForCompaction,
  OPENLIMITS_BODY_COMPACTION_BYTES,
  OPENLIMITS_IMAGE_COMPACTION_COUNT,
} from "./payload-guard.ts";

type CatalogKey = keyof LiveCatalog;
const CATALOG_TTL_MS = 4 * 60 * 60 * 1_000;

export default function openlimitsPlugin(pi: ExtensionAPI): void {
  const { apiKey } = resolveKey();
  let inFlightCatalog: Promise<LiveCatalog> | undefined;
  let compactingOversizedPayload = false;

  pi.on("session_start", () => {
    compactingOversizedPayload = false;
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openlimits-codex") return;

    const imageCount = countEmbeddedImages(event.payload);
    const payloadBytes = measureImageHeavyPayload(event.payload);
    const exceedsBodyLimit = payloadBytes !== undefined && payloadBytes > OPENLIMITS_BODY_COMPACTION_BYTES;
    const exceedsImageLimit = imageCount > OPENLIMITS_IMAGE_COMPACTION_COUNT;
    if (!exceedsBodyLimit && !exceedsImageLimit) return;

    // The compaction summary request sees the same historical images. Strip
    // them from that one request so compaction itself can get under the limit.
    if (compactingOversizedPayload) return preparePayloadForCompaction(event.payload);

    compactingOversizedPayload = true;
    const reason = exceedsBodyLimit
      ? `${(payloadBytes! / 1024 / 1024).toFixed(1)} MiB`
      : `${imageCount} historical images`;
    ctx.ui.notify(`OpenLimits request reached ${reason}; compacting automatically`, "warning");
    ctx.abort();
    ctx.compact({
      customInstructions:
        "Preserve the active task, completed work, decisions, errors, and the assistant's conclusions about inspected images. Older image binaries can be omitted.",
      onComplete: () => {
        compactingOversizedPayload = false;
        ctx.ui.notify("Automatic OpenLimits image compaction completed; continuing", "info");
        pi.sendUserMessage("Continúa desde el punto donde la compactación automática interrumpió la tarea.");
      },
      onError: (error) => {
        compactingOversizedPayload = false;
        ctx.ui.notify(`Automatic OpenLimits image compaction failed: ${error.message}`, "error");
      },
    });
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
    models: CHAT_MODELS,
    refreshModels: refresh("chat", CHAT_MODELS, "openlimits", "openai-completions", OPENAI_BASE),
  });
}
