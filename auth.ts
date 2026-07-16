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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ResolvedKey = {
  apiKey?: string;
  source:
    | "env:OPENLIMITS_API_KEY"
    | "env:ANTHROPIC_API_KEY"
    | "auth.json:openlimits"
    | "auth.json:sk-ol-prefix"
    | "missing";
};

const OPENLIMITS_PREFIX = "sk-ol-";

type ApiKeyCredential = { type?: unknown; key?: unknown };

function looksLikeOpenLimitsKey(value: unknown): value is string {
  return typeof value === "string" && value.trim().startsWith(OPENLIMITS_PREFIX);
}

function credentialKey(value: unknown): string | undefined {
  if (looksLikeOpenLimitsKey(value)) return value.trim();
  if (typeof value !== "object" || value === null) return undefined;
  const key = (value as ApiKeyCredential).key;
  return looksLikeOpenLimitsKey(key) ? key.trim() : undefined;
}

function loadAuthJson(authPath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch {
    return {};
  }
}

export function resolveKey(options: {
  env?: Record<string, string | undefined>;
  authPath?: string;
} = {}): ResolvedKey {
  const env = options.env ?? process.env;
  const authPath = options.authPath ?? path.join(os.homedir(), ".pi", "agent", "auth.json");
  const envKey = env.OPENLIMITS_API_KEY?.trim();
  if (envKey) return { apiKey: envKey, source: "env:OPENLIMITS_API_KEY" };

  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey && anthropicKey.startsWith(OPENLIMITS_PREFIX)) {
    return { apiKey: anthropicKey, source: "env:ANTHROPIC_API_KEY" };
  }

  const data = loadAuthJson(authPath);

  // 3a. Explicit openlimits-named entries first (most specific).
  for (const [provider, value] of Object.entries(data)) {
    const key = credentialKey(value);
    if (provider.toLowerCase().startsWith("openlimits") && key) {
      return { apiKey: key, source: "auth.json:openlimits" };
    }
  }

  // 3b. Any value with the sk-ol- prefix (covers keys stored under arbitrary names).
  for (const value of Object.values(data)) {
    const key = credentialKey(value);
    if (key) {
      return { apiKey: key, source: "auth.json:sk-ol-prefix" };
    }
  }

  return { source: "missing" };
}
