# pi-openlimits

Simple local Pi Coding Agent extension that registers OpenLimits models as Pi providers.

It intentionally does only provider registration: no slash commands, no hooks, no doctor, no background behavior.

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
- GLM/DeepSeek use `openai-completions` with chat-completions-compatible fields.
- `/model` and `pi update --models` refresh the OpenLimits `/v1/models` catalog; the bundled catalog remains available offline.
- Image-heavy GPT sessions are compacted automatically before their serialized request reaches OpenLimits' upstream 50 MiB body guard. Independently, three consecutive generic upstream HTTP 400 rejections trigger one recovery compaction; if the next request still fails, recovery stops instead of looping. Retry and post-compaction turns are triggered with hidden recovery events rather than synthetic user messages. Historical image binaries and duplicate pi-goal checkpoints are omitted only from the compaction-summary request; their latest textual state and conclusions are preserved.
- GPT-5.6 Luna, Sol, and Terra use Pi's native 372K context metadata rather than an unverified 1M declaration.

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
