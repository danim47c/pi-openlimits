// pi-openlimits — registers OpenLimits models as 3 Pi providers.
// No commands, doctor, or background workers.
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

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	anthropicMessagesApi,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	openAICompletionsApi,
	openAIResponsesApi,
	type ProviderStreams,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type {
	ExtensionAPI,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { resolveKey } from "./auth.ts";
import {
	ANTHROPIC_BASE,
	ANTHROPIC_MODELS,
	modelsForLiveIds,
	OPENAI_BASE,
	OPENLIMITS_CHAT_MODELS,
	RESPONSES_MODELS,
} from "./catalog.ts";
import { fetchLiveCatalog, type LiveCatalog } from "./docs-fetcher.ts";
import { preparePayloadForCompaction } from "./payload-guard.ts";
import { loadPricingOverrides, resolveModelPricing } from "./pricing.ts";
import { OpenLimitsRateLimiter, parseRetryAfter } from "./rate-limit.ts";
import {
	OpenLimitsTransientRecovery,
	type TransientKind,
} from "./transient-recovery.ts";

function retryAfterFromHeaders(
	headers: Record<string, string> | undefined,
): number | undefined {
	if (!headers) return undefined;
	const entry = Object.entries(headers).find(
		([name]) => name.toLowerCase() === "retry-after",
	);
	return parseRetryAfter(entry?.[1]);
}

type OpenLimitsRequestPayload =
	| Record<string, unknown>
	| readonly unknown[]
	| string
	| number
	| boolean
	| null
	| undefined;

function parseOpenLimitsRequestPayload(
	payload: unknown,
): OpenLimitsRequestPayload {
	if (payload === null || payload === undefined) return payload;
	if (Array.isArray(payload)) return payload;
	if (typeof payload === "object") {
		// SAFETY: the object branch excludes null and arrays above; JSON request
		// payloads use a string-keyed record at this boundary.
		return payload as Record<string, unknown>;
	}
	if (
		typeof payload === "string" ||
		typeof payload === "number" ||
		typeof payload === "boolean"
	)
		return payload;
	throw new TypeError("OpenLimits provider payload must be JSON-compatible");
}

function enforceOpenLimitsReasoningEffort(
	payload: unknown,
	model: Model<Api>,
	reasoning: SimpleStreamOptions["reasoning"],
): OpenLimitsRequestPayload {
	const parsedPayload = parseOpenLimitsRequestPayload(payload);
	if (
		model.provider !== "openlimits" ||
		model.api !== "openai-completions" ||
		reasoning === undefined ||
		typeof parsedPayload !== "object" ||
		parsedPayload === null ||
		Array.isArray(parsedPayload)
	)
		return parsedPayload;

	const effort = model.thinkingLevelMap?.[reasoning] ?? reasoning;
	return typeof effort === "string"
		? { ...parsedPayload, reasoning_effort: effort }
		: parsedPayload;
}

/**
 * A successful HTTP response that never yields a usable assistant message is
 * not recoverable by retrying forever. Keep this budget deliberately small so
 * a broken upstream cannot hold a Pi session in streaming state indefinitely.
 */
export const EMPTY_RESPONSE_RETRY_MS = 5_000;
export const EMPTY_RESPONSE_MAX_ATTEMPTS = 3;
/** Do not keep a subagent in a retry loop forever when a quota is exhausted. */
export const TRANSIENT_MAX_ATTEMPTS = 3;
/**
 * OpenLimits can answer an oversized Chat Completions request with HTTP 200 and
 * an empty `done` event instead of returning a context-window error. Once the
 * local estimate is this close to the declared window, another retry cannot
 * make the request smaller; surface an overflow error so Pi can compact once.
 * OpenLimits GPT/Opus routes can expose a smaller input ceiling than their
 * published total window, so use a 90% guard to hand silent overflows to Pi
 * before the provider exhausts its invalid-response retry budget.
 */
export const EMPTY_RESPONSE_CONTEXT_OVERFLOW_THRESHOLD = 0.9;
/**
 * Pi's subagent watchdog observes assistant stream events. A long upstream
 * request can otherwise look idle because response content is buffered until
 * `done` for safe retry. No-op thinking deltas keep the run observable without
 * adding text, tool calls, or persisted assistant content.
 */
export const STREAM_PROGRESS_HEARTBEAT_MS = 30_000;
const DEFAULT_EMPTY_RESPONSE_LOG = join(
	homedir(),
	".pi",
	"agent",
	"openlimits-empty-responses.jsonl",
);
const DEFAULT_RATE_LIMIT_EVENTS_LOG = join(
	homedir(),
	".pi",
	"agent",
	"openlimits-rate-limit-events.jsonl",
);
const DIAGNOSTIC_SCHEMA_VERSION = 1;
const MAX_DIAGNOSTIC_EVENTS = 256;

export type EmptyResponseRetryPolicy = {
	/** Maximum number of invalid HTTP 2xx streams before a terminal error. */
	maxAttempts?: number;
	/** Delay between invalid HTTP 2xx attempts. */
	retryDelayMs?: number;
	/** Maximum rate-limit attempts before handing the provider error to Pi. */
	rateLimitMaxAttempts?: number;
	/** Maximum overload attempts before handing the provider error to Pi. */
	overloadMaxAttempts?: number;
	/** Interval for no-op stream heartbeats; zero disables them in tests/tools. */
	progressHeartbeatMs?: number;
};

function emptyResponseLogPath(): string {
	return process.env.OPENLIMITS_EMPTY_RESPONSE_LOG ?? DEFAULT_EMPTY_RESPONSE_LOG;
}

function rateLimitEventsLogPath(): string {
	return (
		process.env.OPENLIMITS_RATE_LIMIT_EVENTS_LOG ?? DEFAULT_RATE_LIMIT_EVENTS_LOG
	);
}

function sanitizeDiagnosticText(value: string, maxLength = 500): string {
	return value
		.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
		.replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
		.replace(
			/([?&](?:api[_-]?key|token|access[_-]?token|authorization)=)[^&\s]+/gi,
			"$1[redacted]",
		)
		.slice(0, maxLength);
}

type DiagnosticErrorMetadata = {
	httpStatus?: number;
	errorType?: string;
	errorCode?: string | number;
	requestId?: string;
};

function extractDiagnosticErrorMetadata(
	value: string,
): DiagnosticErrorMetadata {
	const metadata: DiagnosticErrorMetadata = {};
	const statusMatch = value.match(
		/(?:\b(?:OpenAI|Anthropic) API error\s*\()?([1-5]\d{2})\)?/i,
	);
	if (statusMatch) metadata.httpStatus = Number(statusMatch[1]);

	let parsed: unknown;
	const jsonStart = value.indexOf("{");
	if (jsonStart >= 0) {
		try {
			parsed = JSON.parse(value.slice(jsonStart));
		} catch {
			// The provider may append non-JSON text after the body; regex metadata
			// below is still useful in that case.
		}
	}
	const objects = [
		parsed,
		parsed && typeof parsed === "object" && "error" in parsed
			? (parsed as { error?: unknown }).error
			: undefined,
	];
	for (const candidate of objects) {
		if (typeof candidate !== "object" || candidate === null) continue;
		const record = candidate as Record<string, unknown>;
		if (metadata.httpStatus === undefined && typeof record.status === "number")
			metadata.httpStatus = record.status;
		if (metadata.errorType === undefined && typeof record.type === "string")
			metadata.errorType = sanitizeDiagnosticText(record.type, 100);
		if (
			metadata.errorCode === undefined &&
			(typeof record.code === "string" || typeof record.code === "number")
		)
			metadata.errorCode =
				typeof record.code === "string"
					? sanitizeDiagnosticText(record.code, 100)
					: record.code;
		if (metadata.requestId === undefined) {
			for (const key of ["request_id", "requestId", "request-id"] as const) {
				if (typeof record[key] === "string") {
					metadata.requestId = sanitizeDiagnosticText(record[key], 200);
					break;
				}
			}
		}
	}
	if (metadata.requestId === undefined) {
		const requestIdMatch = value.match(
			/\brequest(?:[_ -]?id)\s*[:=]\s*["']?([A-Za-z0-9._:-]{4,})/i,
		);
		if (requestIdMatch) metadata.requestId = requestIdMatch[1];
	}
	return metadata;
}

function isSuccessfulHttpStatus(status: number | undefined): boolean {
	return status !== undefined && status >= 200 && status < 300;
}

function safeBaseUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return sanitizeDiagnosticText(value, 300);
	}
}

type DiagnosticPayload = {
	sha256: string;
	keys: string[];
	messageCount?: number;
	contentTypes?: string[];
};

type EmptyResponseEvidence = {
	schemaVersion: number;
	timestamp: string;
	attemptId: string;
	attemptNumber: number;
	sessionId: string;
	provider: string;
	api: string;
	model: string;
	baseUrl?: string;
	outcome: "empty_stream" | "reasoning_only" | "truncated_stream";
	durationMs: number;
	maxAttempts: number;
	retryDelayMs: number;
	response?: {
		status: number;
		headers: Record<string, string>;
		retryAfterMs?: number;
	};
	payload?: DiagnosticPayload;
	events: Array<Record<string, unknown>>;
	eventCount: number;
	eventsTruncated?: boolean;
	estimatedContextTokens?: number;
	contextWindow?: number;
	likelyContextOverflow?: boolean;
};

type RateLimitEvidence = {
	schemaVersion: number;
	timestamp: string;
	source: "http_status" | "event_body";
	attemptId: string;
	attemptNumber: number;
	sessionId: string;
	provider: string;
	api: string;
	model: string;
	baseUrl?: string;
	status?: number;
	headers?: Record<string, string>;
	retryAfterMs?: number;
	payload?: DiagnosticPayload;
	event?: Record<string, unknown>;
	events?: Array<Record<string, unknown>>;
	eventCount?: number;
	eventsTruncated?: boolean;
	recovery?: {
		kind: TransientKind;
		blockedUntil: number;
	};
};

function summarizePayload(payload: unknown): EmptyResponseEvidence["payload"] {
	let serialized = "";
	try {
		serialized = JSON.stringify(payload) ?? "null";
	} catch {
		serialized = String(payload);
	}
	const digest = createHash("sha256").update(serialized).digest("hex");
	if (
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload)
	) {
		return { sha256: digest, keys: [] };
	}
	const record = payload as Record<string, unknown>;
	const messages = Array.isArray(record.messages) ? record.messages : undefined;
	const contentTypes = messages?.flatMap((message) => {
		if (typeof message !== "object" || message === null) return [];
		const content = (message as Record<string, unknown>).content;
		if (Array.isArray(content)) {
			return content.flatMap((block) =>
				typeof block === "object" &&
				block !== null &&
				typeof (block as Record<string, unknown>).type === "string"
					? [(block as Record<string, unknown>).type as string]
					: [],
			);
		}
		return [];
	});
	return {
		sha256: digest,
		keys: Object.keys(record).sort((left, right) => left.localeCompare(right)),
		...(messages ? { messageCount: messages.length } : {}),
		...(contentTypes?.length ? { contentTypes: [...new Set(contentTypes)] } : {}),
	};
}

const DIAGNOSTIC_CHARS_PER_TOKEN = 4;
const DIAGNOSTIC_IMAGE_CHARS = 4_800;

function estimateDiagnosticContentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const candidate = block as Record<string, unknown>;
		if (candidate.type === "text" && typeof candidate.text === "string") {
			chars += candidate.text.length;
		} else if (
			candidate.type === "thinking" &&
			typeof candidate.thinking === "string"
		) {
			chars += candidate.thinking.length;
		} else if (candidate.type === "image") {
			chars += DIAGNOSTIC_IMAGE_CHARS;
		} else if (candidate.type === "toolCall") {
			const name = typeof candidate.name === "string" ? candidate.name : "";
			let argumentsText = "";
			try {
				argumentsText = JSON.stringify(candidate.arguments) ?? "";
			} catch {
				argumentsText = "[unserializable]";
			}
			chars += name.length + argumentsText.length;
		}
	}
	return chars;
}

function estimateDiagnosticMessageTokens(
	message: Context["messages"][number],
): number {
	return Math.ceil(
		estimateDiagnosticContentChars(message.content) / DIAGNOSTIC_CHARS_PER_TOKEN,
	);
}

/**
 * Approximate the request context without serializing prompts or tool
 * arguments into diagnostics. When a recent valid assistant usage exists, use
 * it as the authoritative prefix and only estimate messages appended since
 * that response, matching Pi's compaction estimator.
 */
function estimateDiagnosticContextTokens(context: Context): number {
	let latestUsageTokens = 0;
	let latestUsageIndex = -1;
	for (let index = 0; index < context.messages.length; index += 1) {
		const message = context.messages[index];
		if (
			message.role !== "assistant" ||
			message.stopReason === "error" ||
			message.stopReason === "aborted"
		)
			continue;
		const usage = message.usage;
		const tokens =
			usage.totalTokens ||
			usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		if (tokens > 0) {
			latestUsageTokens = tokens;
			latestUsageIndex = index;
		}
	}
	if (latestUsageIndex >= 0) {
		let trailingTokens = 0;
		for (
			let index = latestUsageIndex + 1;
			index < context.messages.length;
			index += 1
		) {
			trailingTokens += estimateDiagnosticMessageTokens(context.messages[index]);
		}
		return latestUsageTokens + trailingTokens;
	}

	let chars = context.systemPrompt?.length ?? 0;
	if (context.tools) {
		try {
			chars += JSON.stringify(context.tools)?.length ?? 0;
		} catch {
			chars += 1;
		}
	}
	for (const message of context.messages) {
		chars +=
			estimateDiagnosticMessageTokens(message) * DIAGNOSTIC_CHARS_PER_TOKEN;
	}
	return Math.ceil(chars / DIAGNOSTIC_CHARS_PER_TOKEN);
}

function summarizeResponseHeaders(
	headers: Record<string, string> | undefined,
): Record<string, string> {
	if (!headers) return {};
	const names =
		/^(content-type|retry-after|request-id|x-request-id|cf-ray|cf-.*|openai-.*|anthropic-.*|server|via|date|x-cache|x-ratelimit-.*|ratelimit(?:-.*)?|x-envoy-.*)$/i;
	return Object.fromEntries(
		Object.entries(headers)
			.filter(([name]) => names.test(name))
			.map(([name, value]) => [name, sanitizeDiagnosticText(String(value), 300)]),
	);
}

function summarizeEvent(event: unknown): Record<string, unknown> {
	if (typeof event !== "object" || event === null) return { type: typeof event };
	const candidate = event as Record<string, unknown>;
	const summary: Record<string, unknown> = { type: candidate.type };
	if (typeof candidate.reason === "string") summary.reason = candidate.reason;
	for (const key of ["delta", "text", "content"] as const) {
		if (typeof candidate[key] === "string")
			summary[`${key}Length`] = candidate[key].length;
	}
	const message = candidate.message ?? candidate.error;
	if (typeof message === "object" && message !== null) {
		const assistant = message as Record<string, unknown>;
		if (typeof assistant.stopReason === "string")
			summary.stopReason = assistant.stopReason;
		if (typeof assistant.responseId === "string")
			summary.responseId = assistant.responseId;
		if (typeof assistant.errorMessage === "string") {
			summary.errorMessage = sanitizeDiagnosticText(assistant.errorMessage);
			const metadata = extractDiagnosticErrorMetadata(assistant.errorMessage);
			if (metadata.httpStatus !== undefined)
				summary.httpStatus = metadata.httpStatus;
			if (metadata.errorType !== undefined) summary.errorType = metadata.errorType;
			if (metadata.errorCode !== undefined) summary.errorCode = metadata.errorCode;
			if (metadata.requestId !== undefined) summary.requestId = metadata.requestId;
		}
		if (Array.isArray(assistant.content)) {
			summary.contentTypes = assistant.content.flatMap((block) =>
				typeof block === "object" &&
				block !== null &&
				typeof (block as Record<string, unknown>).type === "string"
					? [(block as Record<string, unknown>).type as string]
					: [],
			);
		}
	}
	return summary;
}

function captureDiagnosticEvent(
	events: Array<Record<string, unknown>>,
	state: { count: number; truncated: boolean },
	event: unknown,
): void {
	state.count += 1;
	const summary = summarizeEvent(event);
	if (events.length < MAX_DIAGNOSTIC_EVENTS) {
		events.push(summary);
		return;
	}
	state.truncated = true;
	// Keep the first entries and continuously replace the final slot with the
	// latest event, so the terminal reason remains visible without unbounded
	// diagnostic memory growth.
	events[MAX_DIAGNOSTIC_EVENTS - 1] = summary;
}

function summarizeRecoveryState(state: unknown): RateLimitEvidence["recovery"] {
	if (typeof state !== "object" || state === null) return undefined;
	const candidate = state as { kind?: unknown; blockedUntil?: unknown };
	if (
		(candidate.kind !== "rate_limit" && candidate.kind !== "overloaded") ||
		typeof candidate.blockedUntil !== "number"
	)
		return undefined;
	return { kind: candidate.kind, blockedUntil: candidate.blockedUntil };
}

function recordEmptyResponseEvidence(evidence: EmptyResponseEvidence): void {
	void (async () => {
		try {
			await mkdir(dirname(emptyResponseLogPath()), { recursive: true });
			await appendFile(emptyResponseLogPath(), `${JSON.stringify(evidence)}\n`, {
				mode: 0o600,
			});
		} catch {
			// Diagnostics must never interrupt or close the Pi stream.
		}
	})();
}

function recordRateLimitEvidence(evidence: RateLimitEvidence): void {
	void (async () => {
		try {
			await mkdir(dirname(rateLimitEventsLogPath()), { recursive: true });
			await appendFile(rateLimitEventsLogPath(), `${JSON.stringify(evidence)}\n`, {
				mode: 0o600,
			});
		} catch {
			// Diagnostics must never interrupt or close the Pi stream.
		}
	})();
}

function classifyEmptyResponseOutcome(
	events: Array<Record<string, unknown>>,
): EmptyResponseEvidence["outcome"] {
	if (events.length === 0) return "empty_stream";
	const terminal = events.at(-1);
	const contentTypes = terminal?.contentTypes;
	if (
		terminal?.type === "done" &&
		Array.isArray(contentTypes) &&
		contentTypes.length > 0 &&
		contentTypes.every((type) => type === "thinking")
	) {
		return "reasoning_only";
	}
	return "truncated_stream";
}

function waitForEmptyResponseRetry(
	signal: AbortSignal | undefined,
	delayMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		let onAbort: () => void;
		const finish = () => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		const timer = setTimeout(finish, delayMs);
		onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(abortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function isAbortError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		(error as { name?: unknown }).name === "AbortError"
	);
}

function abortError(): Error {
	return new DOMException("The operation was aborted.", "AbortError");
}

function createProgressPartial(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ProgressHeartbeat = {
	enabled: boolean;
	stop: () => void;
};

function startProgressHeartbeat(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	model: Model<Api>,
	signal: AbortSignal | undefined,
	intervalMs: number,
): ProgressHeartbeat {
	if (!Number.isFinite(intervalMs) || intervalMs <= 0 || signal?.aborted) {
		return { enabled: false, stop: () => {} };
	}

	const partial = createProgressPartial(model);
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	};
	const onAbort = () => stop();
	const beat = () => {
		if (stopped || signal?.aborted) {
			stop();
			return;
		}
		stream.push({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "",
			partial,
		});
		timer = setTimeout(beat, intervalMs);
	};

	signal?.addEventListener("abort", onAbort, { once: true });
	stream.push({ type: "start", partial });
	timer = setTimeout(beat, intervalMs);
	return { enabled: true, stop };
}

function isAbortedStreamEvent(event: unknown): boolean {
	if (typeof event !== "object" || event === null) return false;
	const candidate = event as {
		type?: unknown;
		reason?: unknown;
		error?: { stopReason?: unknown; errorMessage?: unknown };
	};
	if (candidate.type !== "error") return false;
	if (
		candidate.reason === "aborted" ||
		candidate.error?.stopReason === "aborted"
	)
		return true;
	return (
		typeof candidate.error?.errorMessage === "string" &&
		/\b(?:the )?operation was aborted\b|\brequest was aborted\b/i.test(
			candidate.error.errorMessage,
		)
	);
}

export function rateLimitedStream(
	api: () => ProviderStreams,
	recovery: OpenLimitsTransientRecovery,
	notify?: (message: string, level?: "info" | "warning" | "error") => void,
	policy?: EmptyResponseRetryPolicy,
): ProviderConfig["streamSimple"] {
	return (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => {
		const stream = createAssistantMessageEventStream();
		const sessionId =
			options?.sessionId ??
			`${model.provider}/${model.id}/${Math.random().toString(36).slice(2)}`;
		const configuredMaxAttempts =
			policy?.maxAttempts ?? EMPTY_RESPONSE_MAX_ATTEMPTS;
		const emptyResponseMaxAttempts = Number.isFinite(configuredMaxAttempts)
			? Math.max(1, Math.floor(configuredMaxAttempts))
			: EMPTY_RESPONSE_MAX_ATTEMPTS;
		const configuredRetryDelayMs =
			policy?.retryDelayMs ?? EMPTY_RESPONSE_RETRY_MS;
		const emptyResponseRetryDelayMs = Number.isFinite(configuredRetryDelayMs)
			? Math.max(0, configuredRetryDelayMs)
			: EMPTY_RESPONSE_RETRY_MS;
		const configuredRateLimitMaxAttempts =
			policy?.rateLimitMaxAttempts ?? TRANSIENT_MAX_ATTEMPTS;
		const rateLimitMaxAttempts = Number.isFinite(configuredRateLimitMaxAttempts)
			? Math.max(1, Math.floor(configuredRateLimitMaxAttempts))
			: TRANSIENT_MAX_ATTEMPTS;
		const configuredOverloadMaxAttempts =
			policy?.overloadMaxAttempts ?? TRANSIENT_MAX_ATTEMPTS;
		const overloadMaxAttempts = Number.isFinite(configuredOverloadMaxAttempts)
			? Math.max(1, Math.floor(configuredOverloadMaxAttempts))
			: TRANSIENT_MAX_ATTEMPTS;
		const progressHeartbeatMs = (() => {
			if (Number.isFinite(policy?.progressHeartbeatMs)) {
				return Math.max(0, Math.floor(policy?.progressHeartbeatMs ?? 0));
			}
			return STREAM_PROGRESS_HEARTBEAT_MS;
		})();
		let emptyResponseAttempts = 0;
		let rateLimitAttempts = 0;
		let overloadAttempts = 0;
		let attemptNumber = 0;
		let lastNoticeAt = 0;
		let wasRecovering = false;
		const display = (
			message: string,
			level: "info" | "warning" | "error" = "info",
			force = false,
		) => {
			if (!notify || (!force && Date.now() - lastNoticeAt < 9_000)) return;
			lastNoticeAt = Date.now();
			try {
				notify(message, level);
			} catch {
				/* UI must never affect recovery. */
			}
		};
		const progressHeartbeat =
			options?.sessionId === undefined
				? undefined
				: startProgressHeartbeat(
						stream,
						model,
						options.signal,
						progressHeartbeatMs,
					);

		void (async () => {
			try {
				for (;;) {
					const waiting = recovery.getState(sessionId);
					if (waiting) {
						const seconds = Math.max(
							1,
							Math.ceil((waiting.blockedUntil - Date.now()) / 1_000),
						);
						display(
							waiting.kind === "rate_limit"
								? `OpenLimits: rate limit en esta sesión; reintentando en ${seconds}s…`
								: `OpenLimits: servidores saturados; reintentando en ${seconds}s…`,
						);
					}
					await recovery.wait(sessionId, options?.signal);
					const attemptId = randomUUID();
					const currentAttemptNumber = ++attemptNumber;
					const attemptStartedAt = Date.now();
					let responseTransient: TransientKind | undefined;
					let responseStatus: number | undefined;
					let recordedTransient = false;
					let validResponse = false;
					let terminalError = false;
					let payloadEvidence: EmptyResponseEvidence["payload"];
					let responseEvidence: EmptyResponseEvidence["response"];
					let shouldRetry = false;
					let invalidResponse = false;
					let attemptProducedContent = false;
					const eventEvidence: Array<Record<string, unknown>> = [];
					const eventEvidenceState = { count: 0, truncated: false };
					// Keep every event private until this attempt has a valid terminal
					// `done`. A provider can close a stream after emitting text or thinking;
					// buffering is what lets us retry that attempt without duplicating a
					// partial assistant message in Pi.
					const bufferedEvents: Parameters<typeof stream.push>[0][] = [];
					const estimatedContextTokens = estimateDiagnosticContextTokens(context);
					const contextWindow =
						typeof model.contextWindow === "number" && model.contextWindow > 0
							? model.contextWindow
							: undefined;
					const likelyContextOverflow =
						contextWindow !== undefined &&
						estimatedContextTokens >=
							contextWindow * EMPTY_RESPONSE_CONTEXT_OVERFLOW_THRESHOLD;
					const recordTransient = (
						kind: TransientKind,
						retryAfterMs?: number,
						sample?: string,
					) => {
						if (recordedTransient) return;
						recordedTransient = true;
						if (kind === "rate_limit") rateLimitAttempts += 1;
						else overloadAttempts += 1;
						wasRecovering = true;
						recovery.recordFailure(
							sessionId,
							kind,
							retryAfterMs,
							typeof sample === "string"
								? sanitizeDiagnosticText(sample, 200)
								: undefined,
						);
						display(
							kind === "rate_limit"
								? "OpenLimits: rate limit en esta sesión; esperando 60s…"
								: "OpenLimits: servidores saturados; reintentando en 5s…",
							"info",
							true,
						);
					};
					const emitPartialStreamError = (errorMessage: string) => {
						bufferedEvents.length = 0;
						stream.push({
							type: "error",
							reason: "error",
							error: {
								role: "assistant",
								content: [],
								api: model.api,
								provider: model.provider,
								model: model.id,
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										total: 0,
									},
								},
								stopReason: "error",
								errorMessage,
								timestamp: Date.now(),
							},
						});
						terminalError = true;
					};
					const recordInvalidResponseEvidence = (
						outcome: EmptyResponseEvidence["outcome"],
					) => {
						recordEmptyResponseEvidence({
							schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
							timestamp: new Date().toISOString(),
							attemptId,
							attemptNumber: currentAttemptNumber,
							sessionId,
							provider: model.provider,
							api: model.api,
							model: model.id,
							...(safeBaseUrl(model.baseUrl)
								? { baseUrl: safeBaseUrl(model.baseUrl) }
								: {}),
							outcome,
							durationMs: Date.now() - attemptStartedAt,
							maxAttempts: emptyResponseMaxAttempts,
							retryDelayMs: emptyResponseRetryDelayMs,
							...(responseEvidence ? { response: responseEvidence } : {}),
							...(payloadEvidence ? { payload: payloadEvidence } : {}),
							events: eventEvidence,
							eventCount: eventEvidenceState.count,
							...(eventEvidenceState.truncated ? { eventsTruncated: true } : {}),
							...(estimatedContextTokens > 0 ? { estimatedContextTokens } : {}),
							...(contextWindow === undefined ? {} : { contextWindow }),
							...(likelyContextOverflow ? { likelyContextOverflow: true } : {}),
						});
					};
					if (options?.signal?.aborted) throw abortError();
					const inner = api().streamSimple(model, context, {
						...options,
						onPayload: async (payload, payloadModel) => {
							const transformed = enforceOpenLimitsReasoningEffort(
								(await options?.onPayload?.(payload, payloadModel)) ?? payload,
								model,
								options?.reasoning,
							);
							payloadEvidence = summarizePayload(transformed);
							return transformed;
						},
						onResponse: async (response, responseModel) => {
							responseStatus = response.status;
							const retryAfterMs = retryAfterFromHeaders(response.headers);
							responseEvidence = {
								status: response.status,
								headers: summarizeResponseHeaders(response.headers),
								...(retryAfterMs === undefined ? {} : { retryAfterMs }),
							};
							// HTTP status is authoritative. Body text is only a fallback when
							// the transport reported a successful status.
							if (isSuccessfulHttpStatus(response.status)) {
								// Some transports can invoke onResponse more than once when
								// their own request retry recovers. The successful callback
								// belongs to the current attempt and must clear the earlier
								// transient marker before we inspect its stream.
								responseTransient = undefined;
								shouldRetry = false;
								recordedTransient = false;
							} else if (response.status === 429) {
								responseTransient = "rate_limit";
								shouldRetry = true;
								recordTransient("rate_limit", retryAfterMs);
								recordRateLimitEvidence({
									schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
									timestamp: new Date().toISOString(),
									source: "http_status",
									attemptId,
									attemptNumber: currentAttemptNumber,
									sessionId,
									provider: model.provider,
									api: model.api,
									model: model.id,
									...(safeBaseUrl(model.baseUrl)
										? { baseUrl: safeBaseUrl(model.baseUrl) }
										: {}),
									status: response.status,
									headers: summarizeResponseHeaders(response.headers),
									...(retryAfterMs === undefined ? {} : { retryAfterMs }),
									...(payloadEvidence ? { payload: payloadEvidence } : {}),
									recovery: summarizeRecoveryState(recovery.getState(sessionId)),
								});
							} else if (response.status >= 500 && response.status < 600) {
								responseTransient = "overloaded";
								shouldRetry = true;
								recordTransient("overloaded");
							} else {
								responseTransient = undefined;
								shouldRetry = false;
							}
							await options?.onResponse?.(response, responseModel);
						},
					});
					for await (const event of inner) {
						captureDiagnosticEvent(eventEvidence, eventEvidenceState, event);
						const eventError = event.type === "error" ? event.error : undefined;
						const successfulResponse = isSuccessfulHttpStatus(responseStatus);
						// Cancellation is authoritative. In particular, pi-ai can turn an
						// aborted request into an assistant error whose text also resembles a
						// premature stream; never classify that event as truncation/retry.
						if (options?.signal?.aborted || isAbortedStreamEvent(event)) {
							throw abortError();
						}
						// The synthetic start emitted by the heartbeat already opens the
						// assistant message for Pi. Suppress the provider's duplicate start;
						// the real terminal message still replaces the synthetic partial.
						if (event.type === "start" && progressHeartbeat?.enabled) continue;
						if (isAssistantContentEvent(event)) attemptProducedContent = true;
						// pi-ai surfaces a few HTTP-success stream truncations as an
						// assistant error event. They are invalid responses, not a
						// transient upstream failure: keep all events private and run the
						// attempt through the bounded empty-response budget.
						if (
							eventError &&
							successfulResponse &&
							isPrematureSuccessfulStreamError(eventError.errorMessage)
						) {
							invalidResponse = true;
							break;
						}
						const eventKind = eventError
							? classifyTransientEvent(eventError, model.provider, model.api)
							: undefined;
						const canUseBodyFallback =
							responseStatus === undefined || isSuccessfulHttpStatus(responseStatus);
						const effectiveEventKind = canUseBodyFallback ? eventKind : undefined;
						if (effectiveEventKind && responseTransient === undefined) {
							responseTransient = effectiveEventKind;
							recordTransient(effectiveEventKind, undefined, eventError?.errorMessage);
						}
						const shouldRecordRateLimitEvent =
							eventError &&
							eventKind === "rate_limit" &&
							(responseStatus === undefined ||
								isSuccessfulHttpStatus(responseStatus) ||
								responseStatus === 429);
						if (shouldRecordRateLimitEvent) {
							const errorMetadata =
								typeof eventError.errorMessage === "string"
									? extractDiagnosticErrorMetadata(eventError.errorMessage)
									: undefined;
							recordRateLimitEvidence({
								schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
								timestamp: new Date().toISOString(),
								source: "event_body",
								attemptId,
								attemptNumber: currentAttemptNumber,
								sessionId,
								provider: model.provider,
								api: model.api,
								model: model.id,
								...(safeBaseUrl(model.baseUrl)
									? { baseUrl: safeBaseUrl(model.baseUrl) }
									: {}),
								...(responseEvidence?.status === undefined
									? errorMetadata?.httpStatus === undefined
										? {}
										: { status: errorMetadata.httpStatus }
									: { status: responseEvidence.status }),
								...(responseEvidence?.headers
									? { headers: responseEvidence.headers }
									: {}),
								...(responseEvidence?.retryAfterMs === undefined
									? {}
									: { retryAfterMs: responseEvidence.retryAfterMs }),
								...(payloadEvidence ? { payload: payloadEvidence } : {}),
								event: eventEvidence.at(-1) ?? summarizeEvent(event),
								events: eventEvidence,
								eventCount: eventEvidenceState.count,
								...(eventEvidenceState.truncated ? { eventsTruncated: true } : {}),
								recovery: summarizeRecoveryState(recovery.getState(sessionId)),
							});
						}
						if ((responseTransient || effectiveEventKind) && !validResponse) {
							// Nothing from a transient attempt is visible to Pi yet, so it is
							// safe to discard its buffered events and retry it.
							shouldRetry = true;
							continue;
						}
						if (event.type === "error") {
							// Discard any buffered partial attempt on a terminal provider
							// error; exposing it would look like a completed response.
							bufferedEvents.length = 0;
							stream.push(event);
							terminalError = true;
							break;
						}
						if (isValidDoneEvent(event)) {
							validResponse = true;
							for (const buffered of bufferedEvents) stream.push(buffered);
							bufferedEvents.length = 0;
							stream.push(event);
							// `done` is terminal by the pi-ai stream contract. Do not
							// inspect or forward anything a broken transport emits after it.
							break;
						}
						if (event.type === "done") {
							// An empty/reasoning-only done is not a successful response. Stop
							// this attempt now so the recovery decision can distinguish a
							// silent empty attempt from a stream that already leaked content.
							bufferedEvents.push(event);
							break;
						}
						bufferedEvents.push(event);
					}
					if (!validResponse && options?.signal?.aborted) throw abortError();
					const transientAttemptsExhausted =
						(responseTransient === "rate_limit" &&
							rateLimitAttempts >= rateLimitMaxAttempts) ||
						(responseTransient === "overloaded" &&
							overloadAttempts >= overloadMaxAttempts);
					if (transientAttemptsExhausted && !validResponse && !terminalError) {
						const kind = responseTransient ?? "overloaded";
						const attempts =
							kind === "rate_limit" ? rateLimitAttempts : overloadAttempts;
						const diagnostic =
							kind === "rate_limit"
								? `OpenLimits rate limit persisted after ${attempts} attempts (429); retry later or use a fallback model.`
								: `OpenLimits upstream remained overloaded after ${attempts} attempts; retry later or use a fallback model.`;
						display(diagnostic, "error", true);
						emitPartialStreamError(diagnostic);
					}
					const invalidSuccessfulStream =
						!terminalError &&
						(invalidResponse || (!validResponse && !responseTransient));
					if (invalidSuccessfulStream) {
						emptyResponseAttempts += 1;
						const emptyOutcome = classifyEmptyResponseOutcome(eventEvidence);
						// Preserve the native overflow hand-off for silent near-window
						// responses, but always give a truncated response that already
						// produced content one retry first. If that retry is also invalid,
						// the second attempt can still be surfaced as native overflow.
						const contextOverflowTerminal =
							likelyContextOverflow &&
							invalidSuccessfulStream &&
							(!attemptProducedContent || emptyResponseAttempts > 1);
						if (
							emptyResponseAttempts >= emptyResponseMaxAttempts ||
							contextOverflowTerminal
						) {
							if (options?.signal?.aborted) throw abortError();
							recordInvalidResponseEvidence(emptyOutcome);
							const diagnostic = contextOverflowTerminal
								? `Your input exceeds the context window of this model. OpenLimits returned an invalid HTTP 2xx stream after ${emptyResponseAttempts} attempt(s) (${emptyOutcome}; estimated context ${estimatedContextTokens}/${contextWindow} tokens).`
								: `OpenLimits response validation budget exhausted after ${emptyResponseAttempts} invalid HTTP 2xx stream(s) (${emptyOutcome}).`;
							display(diagnostic, "error", true);
							stream.push({
								type: "error",
								reason: "error",
								error: {
									role: "assistant",
									content: [],
									api: model.api,
									provider: model.provider,
									model: model.id,
									usage: {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: 0,
										cost: {
											input: 0,
											output: 0,
											cacheRead: 0,
											cacheWrite: 0,
											total: 0,
										},
									},
									stopReason: "error",
									errorMessage: diagnostic,
									timestamp: Date.now(),
								},
							});
							break;
						}
						await waitForEmptyResponseRetry(
							options?.signal,
							emptyResponseRetryDelayMs,
						);
						if (options?.signal?.aborted) throw abortError();
						recordInvalidResponseEvidence(emptyOutcome);
						display(
							emptyOutcome === "reasoning_only"
								? "OpenLimits: respuesta solo con razonamiento; falta texto o tool call, reintentando…"
								: "OpenLimits: stream vacío o incompleto; reintentando…",
							"info",
						);
						shouldRetry = true;
					}
					if (validResponse) {
						// A complete assistant message is authoritative. A transport may
						// have reported an earlier retryable response before yielding the
						// eventual successful stream; never retry after this terminal event.
						shouldRetry = false;
						const globallyRecovered = recovery.recordSuccess(sessionId);
						if (wasRecovering)
							display("OpenLimits: conexión recuperada.", "info", true);
						else if (globallyRecovered)
							display(
								"OpenLimits: otra sesión detectó recuperación; probando de nuevo…",
								"info",
								true,
							);
						wasRecovering = false;
					}
					if (terminalError) break;
					if (shouldRetry) {
						bufferedEvents.length = 0;
						continue;
					}
					for (const buffered of bufferedEvents) stream.push(buffered);
					break;
				}
			} catch (error) {
				const aborted = options?.signal?.aborted || isAbortError(error);
				let errorMessage = String(error);
				if (aborted) errorMessage = "The operation was aborted.";
				else if (error instanceof Error) errorMessage = error.message;
				if (!aborted) display(`OpenLimits: ${errorMessage}`, "error", true);
				stream.push({
					type: "error",
					reason: aborted ? "aborted" : "error",
					error: {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
						stopReason: aborted ? "aborted" : "error",
						errorMessage,
						timestamp: Date.now(),
					},
				});
			} finally {
				progressHeartbeat?.stop();
				stream.end();
			}
		})();
		return stream;
	};
}

function isPrematureSuccessfulStreamError(message: unknown): boolean {
	return (
		typeof message === "string" &&
		/stream ended without finish_reason|stream ended before (?:a terminal response event|message_stop)|(?:connection reset|ECONNRESET)/i.test(
			message,
		)
	);
}

function classifyTransientEvent(
	message: unknown,
	provider: string,
	api: string,
): TransientKind | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const candidate = message as {
		stopReason?: unknown;
		errorMessage?: unknown;
		provider?: unknown;
		api?: unknown;
	};
	if (
		candidate.stopReason !== "error" ||
		typeof candidate.errorMessage !== "string"
	)
		return undefined;
	const olProvider =
		typeof candidate.provider === "string"
			? candidate.provider === provider
			: true;
	const olApi = typeof candidate.api === "string" ? candidate.api === api : true;
	if (!olProvider || !olApi) return undefined;
	const text = candidate.errorMessage;
	// Real OpenLimits rate limit phrasing (e.g. "429 {"…","type":"rate_limit_error",…}" or "429 The request could not be processed.").
	if (provider.startsWith("openlimits") && isOpenLimitsRateLimitText(text))
		return "rate_limit";
	if (/servers? (?:are )?currently overloaded|overloaded/i.test(text))
		return "overloaded";
	if (provider.startsWith("openlimits") && /(?<!\d)5\d\d(?!\d)/.test(text))
		return "overloaded";
	if (
		/stream ended before a terminal response event|stream ended without finish_reason|prematurely (?:closed|ended)|connection reset|ECONNRESET|fetch failed/i.test(
			text,
		)
	)
		return "overloaded";
	if (
		/An error occurred while processing your request\. You can retry your request/i.test(
			text,
		)
	)
		return "overloaded";
	return undefined;
}

function isOpenLimitsRateLimitText(text: string): boolean {
	const leadingStatus = text.match(
		/^\s*(?:OpenAI|Anthropic) API error\s*\((\d{3})\)|^\s*(\d{3})\b/i,
	);
	if (leadingStatus && Number(leadingStatus[1] ?? leadingStatus[2]) !== 429)
		return false;
	if (!/(?<![0-9])429(?![0-9])/.test(text)) return false;
	if (text.includes("Our servers are currently overloaded")) return false;
	if (/edge control plane/i.test(text)) return false;
	if (/(?<![0-9])5\d\d(?![0-9])/.test(text)) return false;
	// The OpenAI/Anthropic SDKs surface non-2xx responses as a formatted
	// `... API error (429)` message, sometimes without preserving the body.
	// Once the leading status is 429, the HTTP status is authoritative; body
	// wording is useful evidence but must not be required for recovery.
	return true;
}

function isValidDoneEvent(event: unknown): boolean {
	if (typeof event !== "object" || event === null) return false;
	const candidate = event as { type?: unknown; message?: { content?: unknown } };
	if (candidate.type !== "done") return false;
	const content = candidate.message?.content;
	if (!Array.isArray(content)) return false;
	return content.some((block) => {
		if (typeof block !== "object" || block === null) return false;
		const value = block as Record<string, unknown>;
		if (value.type === "text")
			return typeof value.text === "string" && value.text.length > 0;
		if (value.type !== "toolCall") return false;
		return (
			typeof value.id === "string" &&
			value.id.length > 0 &&
			typeof value.name === "string" &&
			value.name.length > 0 &&
			typeof value.arguments === "object" &&
			value.arguments !== null
		);
	});
}

/**
 * Detect events that carry substantive assistant content while an attempt is
 * being buffered. `start` is included only when its partial already contains
 * a substantive block; ordinary empty starts are not truncated content.
 */
function isAssistantContentEvent(event: unknown): boolean {
	if (typeof event !== "object" || event === null) return false;
	const candidate = event as {
		type?: unknown;
		partial?: { content?: unknown };
		delta?: unknown;
		content?: unknown;
		toolCall?: unknown;
	};
	if (candidate.type === "text_start" || candidate.type === "thinking_start")
		return false;
	if (
		candidate.type === "text_delta" ||
		candidate.type === "thinking_delta" ||
		candidate.type === "toolcall_delta"
	)
		return typeof candidate.delta === "string" && candidate.delta.length > 0;
	if (candidate.type === "text_end" || candidate.type === "thinking_end")
		return typeof candidate.content === "string" && candidate.content.length > 0;
	if (candidate.type === "toolcall_end") {
		const toolCall = candidate.toolCall;
		if (typeof toolCall !== "object" || toolCall === null) return false;
		const value = toolCall as Record<string, unknown>;
		return (
			value.type === "toolCall" &&
			typeof value.id === "string" &&
			value.id.length > 0 &&
			typeof value.name === "string" &&
			value.name.length > 0 &&
			typeof value.arguments === "object" &&
			value.arguments !== null
		);
	}
	if (candidate.type === "toolcall_start") {
		if (!Array.isArray(candidate.partial?.content)) return false;
		return candidate.partial.content.some((block) => {
			if (typeof block !== "object" || block === null) return false;
			const value = block as Record<string, unknown>;
			return (
				value.type === "toolCall" &&
				typeof value.id === "string" &&
				value.id.length > 0 &&
				typeof value.name === "string" &&
				value.name.length > 0 &&
				typeof value.arguments === "object" &&
				value.arguments !== null
			);
		});
	}
	if (candidate.type !== "start" || !Array.isArray(candidate.partial?.content))
		return false;
	return candidate.partial.content.some((block) => {
		if (typeof block !== "object" || block === null) return false;
		const value = block as Record<string, unknown>;
		if (value.type === "text" || value.type === "thinking") {
			const field = value.type === "text" ? value.text : value.thinking;
			return typeof field === "string" && field.length > 0;
		}
		return (
			value.type === "toolCall" &&
			typeof value.id === "string" &&
			value.id.length > 0 &&
			typeof value.name === "string" &&
			value.name.length > 0 &&
			typeof value.arguments === "object" &&
			value.arguments !== null
		);
	});
}

type CatalogKey = keyof LiveCatalog;
const CATALOG_TTL_MS = 4 * 60 * 60 * 1_000;
// Pi 0.84 replaced the provider-scoped context.store accessor with an
// immutable `stored` snapshot and generation-checked `publish()`. Keep the
// structural compatibility type local so this extension can still be loaded
// by older Pi releases while using the transactional API when it is present.
type RefreshCatalogModel = ProviderModelConfig & { provider?: string };
type RefreshCatalogEntry = {
	checkedAt?: number;
	models: readonly RefreshCatalogModel[];
};
type RefreshContextCompat = {
	credential?: { type?: string; key?: string };
	stored?: Readonly<RefreshCatalogEntry>;
	store?: {
		read(): Promise<RefreshCatalogEntry | undefined>;
		write(entry: RefreshCatalogEntry): Promise<void>;
	};
	publish?: (publication: {
		persist?: RefreshCatalogEntry | null;
		update?: () => void;
	}) => Promise<boolean>;
	allowNetwork: boolean;
	force?: boolean;
	signal?: AbortSignal;
};

function isOpenLimitsProvider(provider: unknown): provider is string {
	return typeof provider === "string" && provider.startsWith("openlimits");
}
export function isOpenLimitsUpstreamRejection(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	const candidate = message as {
		role?: unknown;
		stopReason?: unknown;
		errorMessage?: unknown;
	};
	return (
		candidate.role === "assistant" &&
		candidate.stopReason === "error" &&
		typeof candidate.errorMessage === "string" &&
		candidate.errorMessage.includes("OpenAI API error (400)") &&
		candidate.errorMessage.includes("The upstream provider rejected the request.")
	);
}

type OverflowCompactionHookEvent = {
	reason?: unknown;
	willRetry?: unknown;
	preparation?: {
		firstKeptEntryId: string;
	};
	branchEntries?: readonly {
		id?: unknown;
		type?: unknown;
		message?: unknown;
	}[];
};

function isOpenLimitsOverflowMessage(message: unknown): boolean {
	if (isOpenLimitsUpstreamRejection(message)) return true;
	if (typeof message !== "object" || message === null) return false;
	const candidate = message as {
		role?: unknown;
		stopReason?: unknown;
		errorMessage?: unknown;
	};
	return (
		candidate.role === "assistant" &&
		candidate.stopReason === "error" &&
		typeof candidate.errorMessage === "string" &&
		/Your input exceeds the context window of this model|exceeds (?:the )?(?:model'?s )?maximum context length|prompt is too long|request_too_large/i.test(
			candidate.errorMessage,
		)
	);
}

/**
 * Keep the final OpenLimits overflow error as the compaction boundary.
 *
 * Native Pi removes the final assistant error from in-memory state after an
 * overflow compaction, then calls `agent.continue()`. Earlier native retries
 * remain in the append-only session path, however. If the normal compaction
 * boundary keeps those entries, the rebuilt context can still end in an older
 * assistant error and `agent.continue()` rejects it with "Cannot continue from
 * message role: assistant".
 *
 * Making the final error the first kept entry means the rebuilt context contains
 * only the compaction summary and that final error. Pi removes the latter before
 * retrying, so continuation starts from the summary's user message. This only
 * adjusts the in-memory compaction boundary; it does not alter the journal or
 * manufacture a replacement message.
 */
export function alignOverflowCompactionBoundary(
	event: OverflowCompactionHookEvent,
): boolean {
	if (
		event.reason !== "overflow" ||
		event.willRetry !== true ||
		!event.preparation ||
		!event.branchEntries?.length
	)
		return false;

	const lastEntry = event.branchEntries.at(-1);
	if (
		lastEntry?.type !== "message" ||
		typeof lastEntry.id !== "string" ||
		!isOpenLimitsOverflowMessage(lastEntry.message)
	)
		return false;

	event.preparation.firstKeptEntryId = lastEntry.id;
	return true;
}

export default function openlimitsPlugin(pi: ExtensionAPI): void {
	const { apiKey } = resolveKey();
	let inFlightCatalog: Promise<LiveCatalog> | undefined;
	const transientRecovery = new OpenLimitsTransientRecovery({
		sharedLimiter: new OpenLimitsRateLimiter(),
	});
	let uiNotify:
		| ((message: string, level?: "info" | "warning" | "error") => void)
		| undefined;
	let errorRecoveryAttempted = false;
	let sanitizeNextCompactionRequest = false;

	pi.on("session_start", (_event, ctx) => {
		uiNotify = (message, level = "info") => ctx.ui.notify(message, level);
		errorRecoveryAttempted = false;
		sanitizeNextCompactionRequest = false;
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (isOpenLimitsProvider(ctx.model?.provider)) {
			alignOverflowCompactionBoundary(event);
			sanitizeNextCompactionRequest = ctx.model?.provider === "openlimits-codex";
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "openlimits-codex") return;

		if (sanitizeNextCompactionRequest) {
			sanitizeNextCompactionRequest = false;
			return preparePayloadForCompaction(event.payload);
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (!isOpenLimitsProvider(ctx.model?.provider)) return;
		const message = event.message as {
			role?: unknown;
			stopReason?: unknown;
			errorMessage?: unknown;
		};

		if (!isOpenLimitsUpstreamRejection(message)) {
			if (message.role === "assistant" && message.stopReason !== "error") {
				errorRecoveryAttempted = false;
			}
			return;
		}

		// The generic gateway rejection is OpenLimits' context-overflow signal.
		// Classify the first occurrence so native Pi removes this error assistant
		// before compaction and continues from the preceding user/tool result. Pi
		// owns the one-recovery cap; after a failed compact-and-retry, leave the
		// next rejection visible rather than classifying it again.
		if (errorRecoveryAttempted) return;
		errorRecoveryAttempted = true;
		return {
			message: {
				...event.message,
				errorMessage: `Your input exceeds the context window of this model. OpenLimits recovery classification: ${message.errorMessage}`,
			},
		};
	});

	const refresh =
		(
			family: CatalogKey,
			staticModels: ProviderModelConfig[],
			provider: string,
			api: "anthropic-messages" | "openai-responses" | "openai-completions",
			baseUrl: string,
		): NonNullable<ProviderConfig["refreshModels"]> =>
		async (rawContext) => {
			// SAFETY: Pi 0.84's provider config delivers a generation-scoped
			// snapshot, not the legacy scoped store. We narrow via RefreshContextCompat
			// to keep both shapes under one signature.
			const context = rawContext as unknown as RefreshContextCompat;
			// Pi <=0.83 exposed the scoped store directly. Pi 0.84 passes a
			// generation-scoped snapshot instead; prefer it and fall back only for
			// older runtimes.
			const cached =
				context.stored ?? (context.store ? await context.store.read() : undefined);
			const cachedModels = cached?.models.map(
				({ provider: _provider, ...model }) => model as ProviderModelConfig,
			);
			const pricingOverrides = loadPricingOverrides();
			// Refresh persisted GPT metadata from the Chat model list so caches written
			// before the compat/pricing fixes cannot suppress reasoning_effort or
			// leave the footer with a stale all-zero cost.
			const normalizedCachedModels = cachedModels?.map((model) => {
				const staticModel =
					family === "chat"
						? OPENLIMITS_CHAT_MODELS.find((candidate) => candidate.id === model.id)
						: undefined;
				return {
					...model,
					cost: resolveModelPricing(model.id, family, pricingOverrides),
					...(family === "chat"
						? {
								// Preserve cached model-specific flags, but always carry the
								// Pi 0.84 finish-reason compatibility for this route.
								compat: {
									...(staticModel?.compat ?? model.compat ?? {}),
									supportsFinishReason: false,
								},
							}
						: staticModel
							? { compat: staticModel.compat }
							: {}),
				};
			});
			if (!context.allowNetwork) return normalizedCachedModels ?? staticModels;
			if (
				!context.force &&
				cached?.checkedAt &&
				Date.now() - cached.checkedAt < CATALOG_TTL_MS
			) {
				return normalizedCachedModels ?? staticModels;
			}
			const key =
				context.credential?.type === "api_key" ? context.credential.key : apiKey;
			if (!key) return normalizedCachedModels ?? staticModels;
			inFlightCatalog ??= fetchLiveCatalog(key, context.signal).finally(() => {
				inFlightCatalog = undefined;
			});
			const catalog = await inFlightCatalog;
			if (context.signal?.aborted) return normalizedCachedModels ?? staticModels;
			const models =
				catalog[family].length > 0
					? modelsForLiveIds(family, catalog[family])
					: staticModels;
			const persisted: RefreshCatalogEntry = {
				checkedAt: Date.now(),
				models: models.map((model) => ({
					...model,
					provider,
					api: model.api ?? api,
					baseUrl: model.baseUrl ?? baseUrl,
				})),
			};
			if (context.publish) {
				await context.publish({ persist: persisted });
			} else if (context.store) {
				// Compatibility path for Pi <=0.83.
				await context.store.write(persisted);
			}
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
		streamSimple: rateLimitedStream(
			anthropicMessagesApi,
			transientRecovery,
			(message, level) => uiNotify?.(message, level),
		),
		refreshModels: refresh(
			"anthropic",
			ANTHROPIC_MODELS,
			"openlimits-claude",
			"anthropic-messages",
			ANTHROPIC_BASE,
		),
	});

	pi.registerProvider("openlimits-codex", {
		name: "OpenLimits GPT/Codex",
		baseUrl: OPENAI_BASE,
		api: "openai-responses",
		apiKey,
		models: RESPONSES_MODELS,
		streamSimple: rateLimitedStream(
			openAIResponsesApi,
			transientRecovery,
			(message, level) => uiNotify?.(message, level),
		),
		refreshModels: refresh(
			"responses",
			RESPONSES_MODELS,
			"openlimits-codex",
			"openai-responses",
			OPENAI_BASE,
		),
	});

	pi.registerProvider("openlimits", {
		name: "OpenLimits",
		baseUrl: OPENAI_BASE,
		api: "openai-completions",
		apiKey,
		models: OPENLIMITS_CHAT_MODELS,
		streamSimple: rateLimitedStream(
			openAICompletionsApi,
			transientRecovery,
			(message, level) => uiNotify?.(message, level),
		),
		refreshModels: refresh(
			"chat",
			OPENLIMITS_CHAT_MODELS,
			"openlimits",
			"openai-completions",
			OPENAI_BASE,
		),
	});
}
