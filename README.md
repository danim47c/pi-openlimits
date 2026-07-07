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
- GPT/Codex use `openai-responses` with `reasoningSummary: "concise"` so OpenAI Responses emits visible reasoning summary events in Pi.
- GLM/DeepSeek use `openai-completions` with chat-completions-compatible fields.

## Auth

The extension resolves your OpenLimits API key in this order:

1. `OPENLIMITS_API_KEY`
2. `ANTHROPIC_API_KEY` if it contains an OpenLimits key (`sk-ol-...`)
3. `~/.pi/agent/auth.json` entries starting with `openlimits`
4. Any `~/.pi/agent/auth.json` value starting with `sk-ol-`

The key is never committed or written by this extension.

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
