# pi-openlimits

Simple local Pi Coding Agent extension that registers OpenLimits models as Pi providers.

It registers providers plus lightweight recovery hooks; it adds no slash commands or doctor command.

## Providers

| Provider | Pi API harness | Models |
| --- | --- | --- |
| `openlimits-claude` | `anthropic-messages` (`/v1/messages`) | Claude + Fable models |
| `openlimits-codex` | `openai-responses` (`/v1/responses`) | GPT/Codex models |
| `openlimits` | `openai-completions` (`/v1/chat/completions`) | GLM + DeepSeek models |

The Claude/Codex providers use short model IDs because the provider already implies the family:

- `openlimits-claude/claude-opus-4.8`
- `openlimits-codex/gpt-5.5`
- `openlimits/z-ai/glm-5.2`

Display names include `(OpenLimits)`, for example `Claude Opus 4.8 (OpenLimits)`.

## Reasoning notes

The provider metadata includes the compatibility tweaks needed for Pi/OpenLimits:

- Claude/Fable use `anthropic-messages` with `interleaved-thinking-2025-05-14` and adaptive thinking.
- GPT/Codex use `openai-responses` with visible reasoning summaries and deferred tool-search support.
- GPT models expose native `off`/`xhigh`; GPT-5.6 Sol/Terra/Luna additionally expose `max`.
- GLM/DeepSeek/GPT chat routes use `openai-completions` with chat-completions-compatible fields. On Pi 0.84,
  `supportsFinishReason: false` lets pi-ai finish a valid response when OpenLimits closes the SSE stream
  without a `finish_reason`; tool calls are inferred as `toolUse` and text responses as `stop`.
- `/model` and `pi update --models` refresh the OpenLimits `/v1/models` catalog; the bundled catalog remains available offline.
- OpenLimits' generic upstream HTTP 400 is classified as overflow on the first rejection so Pi's native recovery loop can compact and continue. If the post-compaction retry still fails, the rejection is left visible rather than classified again. During an overflow retry, the compaction boundary is defensively moved to the final classified context-window error so Pi does not resume from an older persisted assistant error. No synthetic user or hidden continuation messages are injected. This also recovers cumulative multimodal-context rejection without disabling image input: historical image binaries and duplicate pi-goal checkpoints are omitted only from the compaction-summary request; their latest textual state and conclusions are preserved.
- OpenLimits HTTP 429s are retried internally up to three times and pause the affected session for 60 seconds (or a longer `Retry-After`); after the budget is exhausted a provider-shaped rate-limit error is surfaced so `pi-subagents` can select a fallback model. A file-backed circuit at `~/.pi/agent/openlimits-rate-limit-circuit.json` coordinates independent subagent processes, opens on the first 429, and permits only one half-open probe. Overloaded/5xx responses retry every 5 seconds. Waiting respects request cancellation.
- Every observed 429 is also appended to `~/.pi/agent/openlimits-rate-limit-events.jsonl` (override with `OPENLIMITS_RATE_LIMIT_EVENTS_LOG`), including its source (`http_status` or `event_body`), parsed status/type/code/request ID when present, request/correlation headers, `Retry-After`, model/session and safe payload/event summaries. The aggregate counter remains in `~/.pi/agent/openlimits-rate-limit.json`. The OpenAI/Anthropic SDKs turn many non-2xx responses into an error event before exposing response headers; those records contain the parsed error metadata and explicitly omit headers that the SDK did not provide.
- Content events (`text_*`, `thinking_*`, and `toolcall_*`) are buffered per attempt and published to Pi only after a valid terminal `done`. This lets a truncated/invalid 2xx stream be retried even after it produced content, without duplicating or combining partial assistant messages. Empty or start-only 2xx streams and truncations after content are retried internally every 5 seconds, up to three invalid attempts. A thinking-only response follows the same bounded retry path because it is not a complete assistant answer. If the request is already at least 95% of the declared model window, a silent invalid 2xx stream is classified as a context overflow so Pi can run its native one-shot compaction/retry; a stream that already produced content gets one retry before that hand-off. Cancellation always takes precedence: an aborted request is not classified or retried as a truncation and retains Pi's `aborted` semantics. Each invalid attempt is appended to `~/.pi/agent/openlimits-empty-responses.jsonl` (override with `OPENLIMITS_EMPTY_RESPONSE_LOG`) with status, headers, policy, payload hash/shape, bounded event summaries and a safe context-size estimate. Diagnostic files never contain API keys, prompts, tool arguments or complete payloads.
- GPT-5.6 Luna, Sol, and Terra use a verified 1.05M context window (approximately 922K input plus 128K output); live OpenLimits probes accepted approximately 920K input tokens and rejected requests above the input ceiling.
- Claude Opus 5 is advertised by the live OpenLimits catalog, but probes currently produce valid tool calls up to approximately 921K input units and empty HTTP 200 responses from approximately 922K onward; its 1M metadata remains conservative until that route returns usable long-context responses.

For persistent subagent resilience, configure at least one model from another
provider in each role's `fallbackModels` list in `~/.pi/agent/settings.json`.
The fallback is selected after the bounded provider retry when the error is a
rate-limit, quota, credit, overload, or unavailable-provider failure. For
example:

```json
{
  "subagents": {
    "agentOverrides": {
      "worker": {
        "model": "openlimits-codex/gpt-5.6-terra",
        "fallbackModels": ["opencode/claude-fable-5", "opencode/gpt-5"]
      }
    }
  }
}
```

## Estimated token cost

OpenLimits does not publish a separate tariff, so the extension now fills each
model's `cost` metadata with the public upstream rates bundled by `pi-ai`
(generated from the models.dev catalogue). Pi then calculates every assistant
message in USD per million tokens using the reported `input`, `output`,
`cacheRead`, and `cacheWrite` usage. OpenAI request-wide pricing tiers are kept
where the catalogue provides them. The value shown by Pi is therefore an
underlying-model estimate, not an OpenLimits charge.

For a model that is not yet in models.dev, a non-zero family fallback is used
so the footer does not silently show `$0.0000`. Set exact rates when needed with
`OPENLIMITS_PRICING_PATH`:

```json
{
  "gpt-future": {
    "input": 5,
    "output": 30,
    "cacheRead": 0.5,
    "cacheWrite": 0,
    "tiers": [
      { "inputTokensAbove": 272000, "input": 10, "output": 45, "cacheRead": 1, "cacheWrite": 0 }
    ]
  },
  "_family": {
    "chat": { "input": 1, "output": 4, "cacheRead": 0.1, "cacheWrite": 0 }
  }
}
```

Rates are USD per million tokens. `cacheRead` and `cacheWrite` are only
non-zero when the upstream response reports those token categories; the
extension does not infer cache hits from context size.

## Auth

The extension resolves your OpenLimits API key in this order:

1. `OPENLIMITS_API_KEY`
2. `ANTHROPIC_API_KEY` if it contains an OpenLimits key (`sk-ol-...`)
3. Canonical `~/.pi/agent/auth.json` API-key credentials whose names start with `openlimits`
4. Any `~/.pi/agent/auth.json` value starting with `sk-ol-`

Pi's native `/login` flow can store a separate credential for each registered provider. The extension also reuses an existing OpenLimits credential as a non-persisted fallback, and never writes keys itself.

## Install

Clone or copy this repo into your Pi extensions directory, for example:

```sh
git clone https://github.com/<your-user>/pi-openlimits ~/.pi/agent/extensions/pi-openlimits
```

Then add the extension path to `~/.pi/agent/settings.json` under `packages`:

```json
{
  "packages": [
    "/Users/you/.pi/agent/extensions/pi-openlimits"
  ]
}
```

Start Pi with an OpenLimits key available:

```sh
OPENLIMITS_API_KEY=<your-openlimits-key> pi
```

Then choose one of the registered models in `/model`, for example:

```text
openlimits-codex/gpt-5.5
openlimits-claude/claude-opus-4.8
openlimits/z-ai/glm-5.2
```
