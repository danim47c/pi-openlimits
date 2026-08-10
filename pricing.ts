// Model pricing used for OpenLimits' estimated session cost.
//
// OpenLimits does not currently publish a price sheet. pi-ai's generated
// catalogue is sourced from models.dev and contains public upstream rates, so
// we reuse those rates instead of maintaining a second hand-written list.
// They are estimates of the underlying model price, not an OpenLimits invoice.
// A local JSON override can be supplied with OPENLIMITS_PRICING_PATH.

import { readFileSync } from "node:fs";

// `providers/openai.models` and `providers/vercel-ai-gateway.models` are
// generated files, but they are not among the provider subpaths that Pi's
// extension loader aliases. Under Jiti those imports are incorrectly resolved
// below `compat.js` (for example `compat.js/providers/openai.models`). The
// stable `providers/all` entrypoint is explicitly aliased by Pi and exposes
// the same generated model records through `getBuiltinModels`.
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

export type PricingTier = ModelCostRate & { inputTokensAbove: number };

export type ModelCostRate = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: PricingTier[];
};

export type PricingFamily = "anthropic" | "responses" | "chat";
export type PricingOverrides = Record<string, ModelCostRate> & {
  _family?: Partial<Record<PricingFamily, ModelCostRate>>;
};

type GeneratedModel = { id: string; cost: ModelCostRate };

function ratesFrom(models: readonly GeneratedModel[]): Record<string, ModelCostRate> {
  return Object.fromEntries(models.map((model) => [model.id, model.cost]));
}

// Vercel's catalogue is the models.dev-shaped catalogue with canonical
// provider/model ids. Merge provider-specific catalogues afterwards so we
// retain OpenAI's request-wide pricing tiers where available.
const GENERATED_RATES: Record<string, ModelCostRate> = {
  ...ratesFrom(getBuiltinModels("vercel-ai-gateway")),
  // OpenAI's first-party catalogue adds request-wide tiers for large inputs.
  // The Vercel entry remains the fallback for a prefixed live id.
  ...ratesFrom(getBuiltinModels("openai")),
};

const FAMILY_FALLBACK = {
  // Conservative estimates for a future live model not yet present in
  // models.dev. The explicit fallback makes the cost visibly non-zero while
  // signalling that users should provide an override when they know the rate.
  responses: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  anthropic: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 2.5 },
  chat: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
} as const;

function candidateIds(modelId: string): string[] {
  const candidates = [modelId];
  if (!modelId.includes("/")) {
    // Static OpenLimits ids intentionally omit upstream family prefixes.
    candidates.push(
      `anthropic/${modelId}`,
      `openai/${modelId}`,
      `zai/${modelId}`,
      `deepseek/${modelId}`,
      `minimax/${modelId}`,
    );
    if (modelId === "fable-5") candidates.push("anthropic/claude-fable-5");
  }
  if (modelId.startsWith("anthropic/")) {
    const short = modelId.slice("anthropic/".length);
    candidates.push(short, `anthropic/${short}`);
    if (short === "fable-5") candidates.push("claude-fable-5", "anthropic/claude-fable-5");
  }
  if (modelId.startsWith("openai/")) {
    const short = modelId.slice("openai/".length);
    // Prefer OpenAI's bare entry so its large-context tiers are retained.
    candidates.unshift(short, `openai/${short}`);
  }
  if (modelId.startsWith("z-ai/")) {
    const short = modelId.slice("z-ai/".length);
    // The z.ai coding catalogue reports zero (included-plan) rates. Prefer
    // the public models.dev gateway rate for an underlying-cost estimate.
    candidates.unshift(`zai/${short}`, modelId, short);
  }
  if (modelId.startsWith("deepseek/")) {
    const short = modelId.slice("deepseek/".length);
    candidates.push(short);
  }
  if (modelId.startsWith("minimax/")) {
    const short = modelId.slice("minimax/".length);
    candidates.push(short, `MiniMax-${short.replace(/^minimax-/, "")}`);
    if (short === "minimax-m3") candidates.push("MiniMax-M3");
  }
  return [...new Set(candidates)];
}

function lookupGeneratedRate(modelId: string): ModelCostRate | undefined {
  for (const candidate of candidateIds(modelId)) {
    const rate = GENERATED_RATES[candidate];
    if (rate) return rate;
  }
  return undefined;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Resolve USD/MTok rates for an OpenLimits model id. */
export function resolveModelPricing(
  modelId: string,
  family: PricingFamily,
  overrides: PricingOverrides = {},
): ModelCostRate {
  for (const candidate of candidateIds(modelId)) {
    const override = overrides[candidate];
    if (override) return override;
  }
  const generated = lookupGeneratedRate(modelId);
  // A models.dev zero can mean "included plan" or simply missing pricing.
  // OpenLimits users asked for an underlying-cost estimate, so do not let an
  // unpriced generated entry silently turn the session footer back to $0.0000.
  if (
    generated &&
    generated.input + generated.output + generated.cacheRead + generated.cacheWrite > 0
  ) {
    return generated;
  }
  return overrides._family?.[family] ?? FAMILY_FALLBACK[family];
}

/** Bundled models.dev-derived rates exposed for diagnostics and tests. */
export const DEFAULT_PRICING = GENERATED_RATES;
export const DEFAULT_PRICING_FAMILY_FALLBACK = FAMILY_FALLBACK;

export function pricingPathEnv(): string | undefined {
  return process.env.OPENLIMITS_PRICING_PATH;
}

/**
 * Load model-level pricing overrides from a JSON file. The file is keyed by
 * model id with input/output/cacheRead/cacheWrite rates in USD per million
 * tokens. Optional tiers use the pi-ai shape. A reserved _family key may map
 * family names to fallback rates. Malformed entries are ignored.
 */
export function loadPricingOverrides(filePath?: string): PricingOverrides {
  const path = filePath ?? pricingPathEnv();
  if (!path) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: PricingOverrides = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (key === "_family" || typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (
        !isFiniteNonNegative(record.input) ||
        !isFiniteNonNegative(record.output) ||
        !isFiniteNonNegative(record.cacheRead) ||
        !isFiniteNonNegative(record.cacheWrite)
      ) continue;
      const tiers = Array.isArray(record.tiers)
        ? record.tiers.filter((tier): tier is PricingTier => {
            if (typeof tier !== "object" || tier === null) return false;
            const entry = tier as Record<string, unknown>;
            return (
              isFiniteNonNegative(entry.inputTokensAbove) &&
              isFiniteNonNegative(entry.input) &&
              isFiniteNonNegative(entry.output) &&
              isFiniteNonNegative(entry.cacheRead) &&
              isFiniteNonNegative(entry.cacheWrite)
            );
          })
        : undefined;
      out[key] = {
        input: record.input,
        output: record.output,
        cacheRead: record.cacheRead,
        cacheWrite: record.cacheWrite,
        ...(tiers?.length ? { tiers } : {}),
      };
    }
    // _family is intentionally not returned as a model id; keep it under the
    // reserved property used by resolveModelPricing().
    const family = (parsed as Record<string, unknown>)._family;
    if (typeof family === "object" && family !== null && !Array.isArray(family)) {
      for (const [name, value] of Object.entries(family as Record<string, unknown>)) {
        if (name !== "anthropic" && name !== "responses" && name !== "chat") continue;
        if (typeof value !== "object" || value === null) continue;
        const record = value as Record<string, unknown>;
        if (
          isFiniteNonNegative(record.input) &&
          isFiniteNonNegative(record.output) &&
          isFiniteNonNegative(record.cacheRead) &&
          isFiniteNonNegative(record.cacheWrite)
        ) {
          out._family ??= {};
          out._family[name] = {
            input: record.input,
            output: record.output,
            cacheRead: record.cacheRead,
            cacheWrite: record.cacheWrite,
          };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function pricingSource(): string {
  return pricingPathEnv() ? `file:${pricingPathEnv()}` : "models.dev (pi-ai bundled catalogue)";
}
