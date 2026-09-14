# `pi-openlimits` — contract for agents and orchestrators

This file documents the runtime contract that subagent orchestrators and any
human operators should know when they call the OpenLimits Pi extension. It is
not a user-facing changelog. Read it before assigning work that reaches this
provider.

## Stream contract

- The provider registers three families (`openlimits-claude`,
  `openlimits-codex`, `openlimits`) that all return a
  `AssistantMessageEventStream`.
- A successful run always emits `start`, then any number of
  `text_*` / `thinking_*` / `toolcall_*` events, then a terminal `done`. A
  terminal `error` replaces `done` when recovery fails. Stream contract lives
  in `@earendil-works/pi-ai`; this provider only adds retries on top.
- All provider content events are buffered per attempt. They are forwarded to
  the consumer only after a valid terminal `done`. Truncations and invalid 2xx
  responses therefore do not duplicate partial output. A separate no-op
  `thinking_delta` heartbeat may be emitted for a real Pi session; it carries
  no content and is never included in the final assistant message.
- Cancellation always wins. An aborted request forwards `error` with
  `stopReason: "aborted"` and never retries or classifies as truncation.

## Latency and silence

Subagents may observe long silent stretches while the provider is waiting on
the upstream HTTP exchange or while a sub-model is in a thinking phase. This
is expected, not a stuck child:

- The first byte from OpenLimits can take tens of seconds during rate-limit
  backoff, cold deploys, or large input pipelines (1M+ token contexts).
- `thinking: max` on a 1M-token context can keep the upstream reasoning for
  minutes before the first `thinking_delta` is streamed back. The Watchdog
  respects the `thinking` level (×10 multiplier) precisely so legitimate
  thinking does not get flagged as `needs_attention` by `pi-subagents`.

Normal Pi requests carry a `sessionId`, so the provider emits a no-op
`thinking_delta` heartbeat every 30 seconds while real content is buffered.
That advances `message_update` activity without changing the assistant output.
A direct caller that omits `sessionId` intentionally gets the historical silent
stream behaviour. If an orchestrator still reports a quiet child, treat a gap
under ten minutes during a thinking turn as live work; inspect the exact run
status before steering, interrupting, or relaunching it.

## Rate-limit and overload behaviour

- HTTP 429s from OpenLimits are retried indefinitely while the session stays
  alive. Each attempt pauses the affected session for at least 5 s (or a
  longer `Retry-After`) and surfaces a per-attempt notice so the user can see
  the stream is still alive (`OpenLimits: rate limit (intento N); reintentando
  en Xs…`). Cancellation always wins; an aborted request returns
  `stopReason: "aborted"` and never retries.
- A file-backed circuit at `~/.pi/agent/openlimits-rate-limit-circuit.json`
  coordinates independent subagent processes. The shared limiter opens on
  the first 429, permits only one half-open probe, and uses a 5 s floor so
  every subagent process retries on the same short cadence.
- 5xx / `overloaded` responses follow the same indefinite loop with a fixed
  5 s backoff (`OpenLimits: servidores saturados, overload (intento N);
  reintentando en Xs…`).
- The OpenAI SDK-formatted `OpenAI API error (401): {"…","type":"authentication_error",…}`
  that OpenLimits occasionally emits on an otherwise-valid session is treated
  as a transient upstream blip on the OpenAI routes only. It rides the same
  5 s overload circuit, never surfaces as a credential diagnostic to Pi, and
  any other 401 phrasing (Anthropic, custom OpenLimits gate, malformed keys)
  still terminates the attempt so a real failure stays visible.
- Finite budgets remain available for tests or intentionally bounded
  integrations through `EmptyResponseRetryPolicy.rateLimitMaxAttempts` /
  `overloadMaxAttempts`. Leaving them unset is the production default.

## Notice noise and bounded-fallback diagnostic

The provider retries 429, the exact OpenAI SDK 401 authentication failure,
and 5xx failures forever (or until cancellation / a finite budget) and emits a
notice per attempt so the user can see the stream
is still alive. That keeps the run observable without producing a visually
broken loop of identical toasts.

A *terminal* assistant error is only emitted when the operator has capped the
budget through `EmptyResponseRetryPolicy.rateLimitMaxAttempts` /
`overloadMaxAttempts` (the production default leaves both unset, so this
branch is unreachable). When that path is exercised, the diagnostic is
worded to stay outside pi-ai's own `isRetryableAssistantError` vocabulary (no
"rate limit", "429", "overloaded", or 5xx digits) so Pi core's blind
exponential-backoff retry does not layer on top. The diagnostic still says
the upstream provider is unavailable so `pi-subagents`' broader
fallback-model classifier can act on it, and it is only shown through the
terminal assistant message (not duplicated through `notify()`).

The interim notice for each in-flight retry attempt includes the attempt
counter and the remaining backoff seconds so the user always sees progress:

- `OpenLimits: rate limit (intento N); reintentando en Xs…`
- `OpenLimits: servidores saturados, overload (intento N); reintentando en Xs…`
- `OpenLimits: rate limit; esperando Xs para el reintento N…`

Each new attempt refreshes the counter, so identical text never repeats
inside the same backoff window. The notice is suppressed only when nothing
about the state has changed.

## Diagnostic logs (off by default for events, on for empty/429)

- `~/.pi/agent/openlimits-rate-limit.json` — current aggregate circuit state.
- `~/.pi/agent/openlimits-rate-limit-events.jsonl` — one line per observed
  429, with parsed status / type / code / `request-id` / safe headers and
  payload summaries (no API keys, prompts, tool arguments, or full payloads).
  Override path with `OPENLIMITS_RATE_LIMIT_EVENTS_LOG`.
- `~/.pi/agent/openlimits-empty-responses.jsonl` — invalid HTTP 2xx streams
  that the provider classified as `empty_stream`, `reasoning_only`, or
  `truncated_stream`. Override path with `OPENLIMITS_EMPTY_RESPONSE_LOG`.
- `~/.pi/agent/openlimits-recovered/` — timestamps marking when a probe
  observed recovery, used to gate the next request after a 429.

## Stream progress heartbeat

When the orchestrator passes a `sessionId`, the provider opens the assistant
message immediately and emits a `thinking_delta` with an empty `delta` every
`STREAM_PROGRESS_HEARTBEAT_MS` (default 30 s) until the attempt reaches a
terminal result. The heartbeat is a no-op assistant event:

- it is published alongside the provider's existing retries and is cancelable
  with `options.signal`;
- it carries an empty assistant content array so it is invisible to the
  footer and to subsequent prompt building;
- it advances `message_update` events so `pi-subagents` can keep its Watchdog
  informed without intrusive notifications.

Tests and tools that need the historical “silent until content” behaviour can
disable the heartbeat with `EmptyResponseRetryPolicy.progressHeartbeatMs = 0`.

The provider never writes its own runtime progress log. If you need a step-by-
step liveness signal, instrument the orchestrator or `pi-subagents`
control event stream instead — those already surface the silent phases.

## Cancellation

- `options.signal` is honoured by the rate-limit wait
  (`OpenLimitsTransientRecovery.wait`), by the empty-response retry delay
  (`waitForEmptyResponseRetry`), and by the inner generator. Aborting a
  request never triggers an empty-response retry and never reclassifies a
  truncated stream.
- `recordSuccess` and `recordFailure` are synchronous at the recovery layer
  so the provider stream cannot be blocked on persistence. Diagnostics flush
  asynchronously and cannot affect the stream.

## Authoring a worker that uses this provider

When you spawn a child agent that will call `openlimits-*` models:

- Set `timeoutMs` of at least 1_200_000 for writers and at least 600_000 for
  reviewers. OpenLimits streams regularly exceed five minutes during
  `thinking: max` on large inputs.
- Pass a `sessionId` (any stable UUID) so the provider can keep the stream
  heartbeat and rate-limit evidence scoped to that worker. If you omit it the
  provider generates a private recovery id and does not emit liveness events.
- Give the worker a task-specific prompt with an explicit file/symbol scope,
  acceptance criteria, validation command, and stop condition. Ask it to
  execute that task rather than to redesign the surrounding workflow.
- Worktree cleanliness is an orchestration concern. A worker must not reset,
  clean, or discard a dirty worktree merely because other workers are using it;
  it should execute the assigned task and report the actual resulting diff.
- When the orchestrator receives a `needs_attention` notice, inspect the exact
  run status and prefer steering the existing child over relaunching it. The
  worktree and partial diff are preserved across a resume handoff.
- Configure at least one non-OpenLimits model as fallback so the bounded
  rate-limit and overload retries can hand off cleanly when exhausted.

## Versioning

`pi-openlimits` follows `0.2.x` semver. Provider IDs and the streaming
contract are stable within a minor; the registry of supported models and the
pricing overrides can shift between minors.
