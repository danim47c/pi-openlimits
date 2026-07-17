// Live refresh: GET https://openlimits.app/v1/models (OpenAI-compatible) returns the
// canonical list. We use this instead of scraping the docs page.

import { ANTHROPIC_BASE, OPENAI_BASE } from "./catalog.ts";

const MODELS_URL = `${OPENAI_BASE}/models`;

export type LiveCatalog = {
  anthropic: string[];
  responses: string[];
  chat: string[];
};

type OpenAIModelsResponse = {
  object: "list";
  data: Array<{ id: string; object: string; owned_by?: string }>;
};

export function partitionModelIds(ids: string[]): LiveCatalog {
  const cat: LiveCatalog = { anthropic: [], responses: [], chat: [] };
  for (const raw of ids) {
    const id = raw.toLowerCase();
    if (id.startsWith("openai/")) {
      cat.responses.push(id);
      // Mirror openai/* IDs into the chat bucket so the openlimits (openai-completions)
      // provider surfaces them in addition to openlimits-codex (openai-responses).
      cat.chat.push(id);
    } else if (id.startsWith("z-ai/") || id.startsWith("deepseek/") || id.startsWith("minimax/")) {
      cat.chat.push(id);
    } else if (id.startsWith("anthropic/")) cat.anthropic.push(id);
  }
  cat.anthropic.sort();
  cat.responses.sort();
  cat.chat = [...new Set(cat.chat)].sort();
  return cat;
}

export async function fetchLiveCatalog(apiKey: string, signal?: AbortSignal): Promise<LiveCatalog> {
  if (!apiKey) {
    throw new Error("No OpenLimits API key resolved.");
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(MODELS_URL, {
      headers: { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey, accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GET /v1/models -> HTTP ${res.status}`);
    const json = (await res.json()) as OpenAIModelsResponse;
    if (json.object !== "list" || !Array.isArray(json.data)) throw new Error("Unexpected /v1/models response shape");
    return partitionModelIds(json.data.map((m) => m.id));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export { ANTHROPIC_BASE, OPENAI_BASE, MODELS_URL };
