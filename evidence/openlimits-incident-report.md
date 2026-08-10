# OpenLimits streaming and rate-limit incident report

Prepared: 2026-08-05
Client: `pi-openlimits` / Pi Coding Agent 0.80.8
Repository revision under investigation: `593a43a`

## Executive summary

The client has observed two related but distinct failure modes when using
OpenLimits:

1. Successful HTTP responses sometimes end with no usable assistant text or
   tool call. The previous client wrapper retried these responses forever.
2. HTTP 429 responses appear while the OpenLimits realtime view still shows
   requests. This is not contradictory: a request can be accepted and logged
   at the gateway before the gateway or its upstream provider rejects it.

The client now bounds invalid-stream retries and persists safe, per-attempt
diagnostics for both invalid streams and 429 responses. The diagnostics omit
API keys, prompts, tool arguments and complete request/response bodies.

The local captures are live and continue to grow while affected Pi processes
are running. During this review they contained approximately 3.6k
invalid-stream attempts and dozens of rate-limit observations; the aggregate
counter is intentionally treated as a live diagnostic, not a frozen incident
total. Detailed 429 records only begin at the moment the per-event log was
enabled, so the aggregate file may contain older observations without a
corresponding detailed JSONL row.

## Evidence: empty and truncated streams

The historical diagnostic capture contained approximately:

- 3,642 invalid attempts;
- 3,639 `truncated_stream` outcomes;
- 3 `reasoning_only` outcomes;
- 13 affected sessions;
- a 149-attempt burst in session
  `019fd151-8c95-7bd6-9665-ed831ea1f886`;
- repeated HTTP 200 `text/event-stream` responses with different response IDs
  and repeated payload hashes inside each burst.

Typical invalid sequence:

```text
HTTP 200
start
done(reason=stop, content=[])
```

The `pi-ai` adapters can also expose truncation as an error event, for example:

```text
Stream ended without finish_reason
Stream ended before a terminal response event
Stream ended before message_stop
```

These are not delivered as assistant content. The local mitigation retries at
most three invalid successful streams by default and then emits one terminal
diagnostic error. A complete text response or complete tool call ends the
attempt normally.

## Session handoff and context growth

The requested handoff session
`019fd151-8c95-7bd6-9665-ed831ea1f886` recorded a final assistant usage of
`input=405947`, `output=2708`, `totalTokens=408655`; the arithmetic is
consistent. The 149 invalid attempts associated with that session were
transport-level retries hidden from Pi, so they do not appear as 149 ordinary
assistant messages in the session JSONL.

The context expansion measured during the investigation came primarily from
large persisted `toolResult`/command dumps and images across compaction
boundaries. It was not caused by a broken `405947 + 2708` token sum. Pi
0.80.8 also rejects `agent.continue()` when the rebuilt context ends in an
`assistant` message (`Cannot continue from message role: assistant`). The
extension now keeps the final classified OpenLimits overflow error as the
compaction boundary; native Pi removes that terminal error before retrying.
The same boundary guard is applied to both `openlimits-codex` and the
`openlimits` Chat Completions provider.

## Follow-up session: `019fd238-af37-7b66-97b8-bc4b5410615d`

The later session supplied during the investigation reproduces the same
transport behavior, but it also makes the context trigger visible:

- The selected route was `openlimits` / `openai-completions` / `gpt-5.6-sol`,
  not `openlimits-codex` / Responses.
- The branch reached `tokensBefore=373198` at its 15:27:22 compaction. The
  preceding valid assistant usages grew from roughly 17k to 370k tokens.
- Large tool-result dumps account for the jumps: a 240,411-character artifact
  dump at 14:40 and a 391,266-character combined dump at 15:21 were persisted
  in the same turn. These are session-history/context growth, not token-sum
  arithmetic errors.
- At 15:25:44, 15:25:55 and 15:26:05, OpenLimits returned HTTP 200
  `text/event-stream` responses with different Cloudflare Ray IDs and response
  IDs. Every stream was only `start` followed by `done(reason=stop,
  content=[])`; no 429 record belongs to this session.
- The old bounded wrapper therefore emitted
  `OpenLimits response validation budget exhausted after 3 invalid HTTP 2xx
  stream(s) (truncated_stream).` The session then compacted once successfully;
  there is no evidence of an infinite compaction loop in this JSONL.

This is consistent with a request crossing the declared 372k window after a
large tool result was appended during an in-progress tool turn. Pi normally
compacts only when that turn settles, while OpenLimits returned an empty 200
instead of an explicit overflow error. The client now estimates the request
context without persisting its contents and, at 95% of the model window, turns
the first invalid 200 into Pi's recognized context-overflow error. Pi can then
perform its single native compact-and-retry; its existing overflow cap prevents
that recovery from looping.

## Evidence: 429 responses

The client has observed generic messages shaped like:

```text
429 The request could not be processed.
```

The same status also arrives through the SDK as a terminal assistant error,
for example:

```text
OpenAI API error (429): {"message":"The request could not be processed.","type":"rate_limit_error","code":429}
```

The local wrapper now treats the leading HTTP 429 as authoritative even when
the provider body wording changes. It extracts only safe scalar fields such as
`status`, `type`, `code` and `request_id` into the diagnostic record. In this
SDK error-event path, response headers are not available to the extension, so
`x-request-id`, `cf-ray` and `Retry-After` may be absent; this is a limitation
of the adapter, not evidence that the gateway omitted them.

This wording is OpenLimits-shaped, but it does not prove whether the 429 was
generated by the OpenLimits edge/gateway or propagated from the upstream model
provider. The realtime request list only proves that OpenLimits received the
request; it does not prove that the upstream call completed successfully.

A separate outer Codex execution also reported:

```text
exceeded retry limit, last status: 429 Too Many Requests,
request id: a2666819182efd05-MAD
```

That error was emitted by the service executing Codex, not by the local
`pi-openlimits` provider path. It should not be attributed to OpenLimits unless
the same request ID appears in OpenLimits telemetry.

Possible 429 sources to distinguish:

- OpenLimits ingress, account, concurrency, model or quota policy;
- an edge/CDN or control-plane limiter;
- an upstream provider response forwarded by OpenLimits;
- a 429-shaped provider error carried inside an HTTP 200 response.

## What we need from OpenLimits

For the attached diagnostic records, please correlate `timestamp`, `model`,
`x-request-id`/`request-id`, `cf-ray` and `Retry-After` with gateway and
upstream logs, and answer:

1. Was each 429 generated by OpenLimits or received from the upstream model
   provider?
2. What does the realtime request state represent: ingress, dispatch,
   upstream completion, or only billing/usage acceptance?
3. Which limits were active for the affected key/model (requests, concurrent
   streams, tokens, credits or provider quota)?
4. Is `Retry-After` authoritative, and does it apply per key, model, session,
   IP or account?
5. Are HTTP 200 streams ending with an empty `done` response expected gateway
   behavior or an upstream streaming defect?
6. Can you provide the upstream provider status, response ID and sanitized
   failure reason for each correlated request?
7. For SDK error-event responses, can you expose the original response headers
   (especially `x-request-id`, `cf-ray` and `Retry-After`) to the client or
   include them in the error body?

## Local diagnostic files

The client writes mode-0600 JSONL records to:

- `~/.pi/agent/openlimits-empty-responses.jsonl` (invalid stream attempts);
- `~/.pi/agent/openlimits-rate-limit-events.jsonl` (individual 429
  observations; configurable with `OPENLIMITS_RATE_LIMIT_EVENTS_LOG`);
- `~/.pi/agent/openlimits-rate-limit.json` (aggregate transient counters).

The first two files contain only safe metadata: status, selected response
headers, correlation IDs, retry timing, payload hash/shape and bounded event
summaries. Attach those records rather than raw request payloads.

## Client-side mitigations already applied

- Invalid successful streams are buffered privately and bounded to three
  attempts by default.
- Near the model-window boundary, an invalid successful stream is promoted to
  a native overflow recovery signal immediately, avoiding repeated oversized
  requests.
- HTTP 429s pause only the affected session for 60 seconds or the larger
  `Retry-After` value.
- The first generic OpenLimits upstream HTTP 400 is classified as context
  overflow for native compaction; a failed post-compaction retry is not
  classified repeatedly.
- Compaction boundaries are aligned to avoid resuming from a persisted
  assistant error (`Cannot continue from message role: assistant`).
- A 429-shaped body on an HTTP 400 is not treated as a 429; the observed HTTP
  status wins. This prevents a provider error body from opening the wrong
  recovery circuit.
