// Resolve the OpenLimits API key without ever writing it to disk inside config.
// Order of precedence:
//   1. process.env.OPENLIMITS_API_KEY
//   2. process.env.ANTHROPIC_API_KEY (fallback if only Anthropic-style envs are set)
//   3. ~/.pi/agent/auth.json:
//        a. any entry whose key starts with "openlimits" (case-insensitive)
//        b. any string value starting with "sk-ol-" (OpenLimits key prefix)
//   4. missing
//
// `sk-ol-` sniffing covers the common case where the user saved the key under a
// non-openlimits provider name (e.g. "openai-codex-2", "claude-bridge") before
// the plugin existed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ResolvedKey = {
  apiKey: string;
  source:
    | "env:OPENLIMITS_API_KEY"
    | "env:ANTHROPIC_API_KEY"
    | "auth.json:openlimits"
    | "auth.json:sk-ol-prefix"
    | "missing";
};

const OPENLIMITS_PREFIX = "sk-ol-";

function looksLikeOpenLimitsKey(value: unknown): value is string {
  return typeof value === "string" && value.trim().startsWith(OPENLIMITS_PREFIX);
}

function loadAuthJson(): Record<string, unknown> {
  const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
  try {
    return JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch {
    return {};
  }
}

export function resolveKey(): ResolvedKey {
  const envKey = process.env.OPENLIMITS_API_KEY?.trim();
  if (envKey) return { apiKey: envKey, source: "env:OPENLIMITS_API_KEY" };

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey && anthropicKey.startsWith(OPENLIMITS_PREFIX)) {
    return { apiKey: anthropicKey, source: "env:ANTHROPIC_API_KEY" };
  }

  const data = loadAuthJson();

  // 3a. Explicit openlimits-named entries first (most specific).
  for (const [provider, value] of Object.entries(data)) {
    if (provider.toLowerCase().startsWith("openlimits") && looksLikeOpenLimitsKey(value)) {
      return { apiKey: value.trim(), source: "auth.json:openlimits" };
    }
  }

  // 3b. Any value with the sk-ol- prefix (covers keys stored under arbitrary names).
  for (const value of Object.values(data)) {
    if (looksLikeOpenLimitsKey(value)) {
      return { apiKey: value.trim(), source: "auth.json:sk-ol-prefix" };
    }
  }

  return { apiKey: "missing", source: "missing" };
}
