import { afterAll, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rateLimitedStream } from "./index.ts";
import { isRetryableAssistantError } from "./node_modules/@earendil-works/pi-ai/dist/utils/retry.js";
import { isContextOverflow } from "./node_modules/@earendil-works/pi-ai/dist/utils/overflow.js";

const diagnosticNonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const testDiagnosticsPath = join(tmpdir(), `pi-openlimits-empty-${diagnosticNonce}.jsonl`);
const testRateLimitDiagnosticsPath = join(tmpdir(), `pi-openlimits-rate-limit-${diagnosticNonce}.jsonl`);
process.env.OPENLIMITS_EMPTY_RESPONSE_LOG = testDiagnosticsPath;
process.env.OPENLIMITS_RATE_LIMIT_EVENTS_LOG = testRateLimitDiagnosticsPath;
afterAll(async () => {
	await rm(testDiagnosticsPath, { force: true });
	await rm(testRateLimitDiagnosticsPath, { force: true });
	delete process.env.OPENLIMITS_EMPTY_RESPONSE_LOG;
	delete process.env.OPENLIMITS_RATE_LIMIT_EVENTS_LOG;
});

const model = { api: "openai-completions", provider: "openlimits", id: "test-model" };
const context = { messages: [] };

function rateLimitError() {
	return {
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			stopReason: "error",
			errorMessage: "429 The request could not be processed.",
		},
	};
}

function successEvents() {
	const partial = { role: "assistant", content: [] };
	const message = { role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop" };
	return [
		{ type: "start", partial },
		{ type: "text_delta", contentIndex: 0, delta: "recovered", partial },
		{ type: "done", reason: "stop", message },
	];
}

function fakeApi(attempts) {
	return () => ({
		streamSimple(_model, _context, options) {
			const attempt = attempts.length;
			attempts.push(options);
			return (async function* () {
				if (attempt < 3) {
					await options.onResponse?.({ status: 429, headers: {} }, model);
					yield rateLimitError();
					return;
				}
				await options.onResponse?.({ status: 200, headers: {} }, model);
				yield* successEvents();
			})();
		},
	});
}

describe("rateLimitedStream 429 recovery", () => {
	test("hides initial 429 attempts, waits before the fourth request, and forwards recovery", async () => {
		const attempts = [];
		const limiter = {
			acquires: 0,
			recorded429: 0,
			waitedForFourthRequest: false,
			getState() { return undefined; },
			async wait() {
				this.acquires += 1;
				if (this.acquires === 4) this.waitedForFourthRequest = true;
			},
			recordFailure() { this.recorded429 += 1; },
			recordSuccess() { return false; },
		};
		const responses = [];
		const events = [];
		for await (const event of rateLimitedStream(fakeApi(attempts), limiter, undefined, {
			rateLimitMaxAttempts: 4,
		})(model, context, {
			onResponse: (response) => responses.push(response.status),
		})) events.push(event);

		expect(attempts).toHaveLength(4);
		expect(responses).toEqual([429, 429, 429, 200]);
		expect(limiter).toMatchObject({ acquires: 4, recorded429: 3, waitedForFourthRequest: true });
		expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
		expect(events.some((event) => event.type === "error")).toBe(false);
	});

	test("bounds a persistent 429 so pi-subagents can select a fallback model", async () => {
		let attempts = 0;
		const limiter = {
			getState() { return undefined; },
			async wait() {},
			recordFailure() {},
			recordSuccess() { return false; },
		};
		const api = () => ({
			streamSimple(_model, _context, options) {
				attempts += 1;
				return (async function* () {
					await options.onResponse?.({ status: 429, headers: {} }, model);
					yield rateLimitError();
				})();
			},
		});

		const events = await collect(rateLimitedStream(api, limiter, undefined, {
			rateLimitMaxAttempts: 2,
			retryDelayMs: 0,
		})(model, context));

		expect(attempts).toBe(2);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "error", reason: "error" });
		expect(events[0].error.errorMessage).toContain("429");
	});

	test("uses fallback 429 classification once and ends aborted during recovery", async () => {
		const controller = new AbortController();
		let requests = 0;
		const limiter = {
			recorded429: 0,
			getState() { return requests === 0 ? undefined : { kind: "rate_limit", blockedUntil: Date.now() + 60_000 }; },
			async wait(_sessionId, signal) {
				if (requests === 0) return;
				await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true }));
			},
			recordFailure() { this.recorded429 += 1; },
			recordSuccess() { return false; },
		};
		const api = () => ({
			streamSimple() {
				requests += 1;
				return (async function* () { yield rateLimitError(); })();
			},
		});
		const pending = (async () => {
			const events = [];
			for await (const event of rateLimitedStream(api, limiter)(model, context, { signal: controller.signal })) events.push(event);
			return events;
		})();
		setTimeout(() => controller.abort(), 10);
		const events = await pending;

		expect(requests).toBe(1);
		expect(limiter.recorded429).toBe(1);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "error", reason: "aborted", error: { stopReason: "aborted" } });
	});
});

function immediateLimiter() {
	return {
		getState() { return undefined; },
		async wait(_sessionId, signal) {
			if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
		},
		recordFailure() {},
		recordSuccess() { return false; },
	};
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

async function diagnosticLines(path, minimum = 1) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const lines = (await readFile(path, "utf8"))
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			if (lines.length >= minimum) return lines;
		} catch {
			// The best-effort writer may not have created the file yet.
			if (minimum === 0) return [];
		}
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${minimum} diagnostic line(s) in ${path}`);
}

test("persists safe HTTP 429 evidence with response correlation metadata", async () => {
	let attempts = 0;
	const limiter = {
		getState() { return undefined; },
		async wait() {},
		recordFailure() {},
		recordSuccess() { return false; },
	};
	const api = () => ({
		streamSimple(_model, _context, options) {
			const attempt = attempts++;
			return (async function* () {
				if (attempt === 0) {
					await options.onResponse?.({
						status: 429,
						headers: {
							"content-type": "application/json",
							"retry-after": "7",
							"x-request-id": "req-rate-limit-1",
							authorization: "Bearer should-not-be-persisted",
						},
					}, model);
					yield rateLimitError();
					return;
				}
				await options.onResponse?.({ status: 200, headers: {} }, model);
				yield* successEvents();
			})();
		},
	});

	const before = await diagnosticLines(testRateLimitDiagnosticsPath, 0);
	await collect(rateLimitedStream(api, limiter, undefined, { retryDelayMs: 0 })(model, context));
	const records = await diagnosticLines(testRateLimitDiagnosticsPath, before.length + 1);
	const record = records.slice(before.length).find((entry) => entry.source === "http_status");

	expect(record).toMatchObject({
		schemaVersion: 1,
		source: "http_status",
		status: 429,
		retryAfterMs: 7_000,
		headers: { "x-request-id": "req-rate-limit-1" },
	});
	expect(record.headers.authorization).toBeUndefined();
	expect(JSON.stringify(record)).not.toContain("should-not-be-persisted");
});

test("persists the SDK error body even when the HTTP 429 callback also fires", async () => {
	let attempts = 0;
	const limiter = {
		getState() { return undefined; },
		async wait() {},
		recordFailure() {},
		recordSuccess() { return false; },
	};
	const api = () => ({
		streamSimple(_model, _context, options) {
			const attempt = attempts++;
			return (async function* () {
				if (attempt > 0) {
					await options.onResponse?.({ status: 200, headers: {} }, model);
					yield* successEvents();
					return;
				}
				await options.onResponse?.({
					status: 429,
					headers: { "x-request-id": "req-http-and-body-1" },
				}, model);
				yield {
					type: "error",
					reason: "error",
					error: {
						role: "assistant",
						stopReason: "error",
						provider: "openlimits",
						api: "openai-completions",
						errorMessage: 'OpenAI API error (429): {"type":"rate_limit_error","code":429,"request_id":"rl-body-1"}',
					},
				};
			})();
		},
	});

	const before = await diagnosticLines(testRateLimitDiagnosticsPath, 0);
	await collect(rateLimitedStream(api, limiter, undefined, { retryDelayMs: 0 })(model, context));
	const records = await diagnosticLines(testRateLimitDiagnosticsPath, before.length + 2);
	const bodyRecord = records.slice(before.length).find((entry) => entry.source === "event_body");

	expect(bodyRecord).toMatchObject({
		source: "event_body",
		status: 429,
		headers: { "x-request-id": "req-http-and-body-1" },
		event: { requestId: "rl-body-1", errorType: "rate_limit_error", errorCode: 429 },
	});
});

test("persists a 429 carried by an HTTP 200 stream event", async () => {
	let attempts = 0;
	const limiter = {
		getState() { return undefined; },
		async wait() {},
		recordFailure() {},
		recordSuccess() { return false; },
	};
	const api = () => ({
		streamSimple(_model, _context, options) {
			const attempt = attempts++;
			return (async function* () {
				await options.onResponse?.({ status: 200, headers: { "x-request-id": "req-body-rate-limit-1" } }, model);
				if (attempt === 0) {
					yield {
						type: "error",
						reason: "error",
						error: {
							role: "assistant",
							stopReason: "error",
							errorMessage: "429 The request could not be processed.",
						},
					};
					return;
				}
				yield* successEvents();
			})();
		},
	});

	const before = await diagnosticLines(testRateLimitDiagnosticsPath, 0);
	await collect(rateLimitedStream(api, limiter, undefined, { retryDelayMs: 0 })(model, context));
	const records = await diagnosticLines(testRateLimitDiagnosticsPath, before.length + 1);
	const record = records.slice(before.length).find((entry) => entry.source === "event_body");

	expect(record).toMatchObject({
		schemaVersion: 1,
		source: "event_body",
		status: 200,
		headers: { "x-request-id": "req-body-rate-limit-1" },
		event: { errorMessage: "429 The request could not be processed." },
	});
});

test("retries and persists the SDK-formatted HTTP 429 event", async () => {
	let attempts = 0;
	const limiter = {
		getState() { return undefined; },
		async wait() {},
		recordFailure() {},
		recordSuccess() { return false; },
	};
	const api = () => ({
		streamSimple() {
			const attempt = attempts++;
			return (async function* () {
				if (attempt === 0) {
					yield {
						type: "error",
						reason: "error",
						error: {
							role: "assistant",
							stopReason: "error",
							provider: "openlimits",
							api: "openai-completions",
							errorMessage: 'OpenAI API error (429): {"message":"Too Many Requests","type":"rate_limit_error","code":429,"request_id":"rl-1234"}',
						},
					};
					return;
				}
				yield* successEvents();
			})();
		},
	});

	const before = await diagnosticLines(testRateLimitDiagnosticsPath, 0);
	const events = await collect(rateLimitedStream(api, limiter, undefined, {
		retryDelayMs: 0,
	})(model, context));
	const records = await diagnosticLines(testRateLimitDiagnosticsPath, before.length + 1);
	const record = records.slice(before.length).find((entry) => entry.source === "event_body");

	expect(attempts).toBe(2);
	expect(events.at(-1)).toMatchObject({ type: "done" });
	expect(record).toMatchObject({
		status: 429,
		event: {
			httpStatus: 429,
			errorType: "rate_limit_error",
			errorCode: 429,
			requestId: "rl-1234",
		},
	});
});

test("persists expanded metadata for an invalid stream", async () => {
	const api = () => ({
		streamSimple(_model, _context, options) {
			return (async function* () {
				await options.onPayload?.({
					messages: [{ role: "user", content: "private prompt" }],
					api_key: "sk-test-secret-value",
				}, model);
				await options.onResponse?.({ status: 200, headers: { "x-request-id": "req-empty-1" } }, model);
				yield { type: "done", reason: "stop", message: { role: "assistant", content: [], stopReason: "stop" } };
			})();
		},
	});

	const before = await diagnosticLines(testDiagnosticsPath, 0);
	await collect(rateLimitedStream(api, immediateLimiter(), undefined, {
		maxAttempts: 1,
		retryDelayMs: 0,
	})(model, context, {
		onPayload: () => ({
			messages: [{ role: "user", content: "private prompt" }],
			api_key: "sk-test-secret-value",
		}),
	}));
	const records = await diagnosticLines(testDiagnosticsPath, before.length + 1);
	const record = records.at(-1);

	expect(record).toMatchObject({
		schemaVersion: 1,
		attemptNumber: 1,
		maxAttempts: 1,
		retryDelayMs: 0,
		outcome: "truncated_stream",
		response: { status: 200, headers: { "x-request-id": "req-empty-1" } },
		payload: { messageCount: 1, keys: ["api_key", "messages"] },
		eventCount: 1,
	});
	expect(JSON.stringify(record)).not.toContain("private prompt");
	expect(JSON.stringify(record)).not.toContain("sk-test-secret-value");
});

test("turns a near-window empty 2xx stream into one native overflow recovery", async () => {
	let requests = 0;
	const api = () => ({
		streamSimple(_model, _context, options) {
			requests += 1;
			return (async function* () {
				await options.onResponse?.({ status: 200, headers: { "cf-ray": "ray-overflow-1" } }, model);
				yield {
					type: "done",
					reason: "stop",
					message: { role: "assistant", content: [], stopReason: "stop" },
				};
			})();
		},
	});
	const highContextModel = { ...model, contextWindow: 100 };
	const highContext = {
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "previous" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 90,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 90,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "read",
				content: [{ type: "text", text: "x".repeat(40) }],
				isError: false,
				timestamp: 2,
			},
		],
	};

	const before = await diagnosticLines(testDiagnosticsPath, 0);
	const events = await collect(rateLimitedStream(api, immediateLimiter(), undefined, {
		retryDelayMs: 0,
	})(highContextModel, highContext));
	const records = await diagnosticLines(testDiagnosticsPath, before.length + 1);
	const record = records.slice(before.length).at(-1);

	expect(requests).toBe(1);
	expect(events).toHaveLength(1);
	expect(events[0].type).toBe("error");
	expect(events[0].error.stopReason).toBe("error");
	expect(typeof events[0].error.errorMessage).toBe("string");
	expect(events[0].error.errorMessage).toContain("Your input exceeds the context window of this model");
	expect(isContextOverflow(events[0].error, 100)).toBe(true);
	expect(record).toMatchObject({
		likelyContextOverflow: true,
		contextWindow: 100,
		estimatedContextTokens: 100,
		response: { status: 200, headers: { "cf-ray": "ray-overflow-1" } },
	});
});

test("retries a near-window truncation after content before handing off to overflow recovery", async () => {
	let requests = 0;
	const api = () => ({
		streamSimple(_model, _context, options) {
			const attempt = requests++;
			return (async function* () {
				await options.onResponse?.({ status: 200, headers: {} }, model);
				if (attempt === 0) {
					const partial = { role: "assistant", content: [] };
					yield { type: "start", partial };
					yield { type: "text_delta", contentIndex: 0, delta: "partial", partial };
					return;
				}
				yield* successEvents();
			})();
		},
	});
	const highContextModel = { ...model, contextWindow: 100 };
	const highContext = {
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: "previous" }],
			usage: {
				input: 95,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 95,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		}],
	};
	const events = await collect(rateLimitedStream(api, immediateLimiter(), undefined, {
		maxAttempts: 2,
		retryDelayMs: 0,
	})(highContextModel, highContext));

	expect(requests).toBe(2);
	expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
	expect(events.at(-1)).toMatchObject({ type: "done" });
});

test("retries a thinking-only response without exposing partial events", async () => {
	let requests = 0;
	const api = () => ({
		streamSimple() {
			requests += 1;
			return (async function* () {
				const partial = { role: "assistant", content: [{ type: "thinking", thinking: "internal" }] };
				yield { type: "start", partial };
				yield { type: "thinking_start", contentIndex: 0, partial };
				yield { type: "thinking_delta", contentIndex: 0, delta: "internal", partial };
				yield { type: "done", reason: "stop", message: { ...partial, stopReason: "stop" } };
			})();
		},
	});
	const events = await collect(rateLimitedStream(api, immediateLimiter(), undefined, {
		maxAttempts: 3,
		retryDelayMs: 0,
	})(model, context));

	expect(requests).toBe(3);
	expect(events).toHaveLength(1);
	expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
	expect(events.at(-1).error.errorMessage).toContain("response validation budget exhausted");
});

test("retries an invalid stream before a later response succeeds", async () => {
	const controller = new AbortController();
	let attempts = 0;
	const api = () => ({
		streamSimple() {
			const attempt = attempts++;
			return (async function* () {
				if (attempt < 2) {
					yield { type: "start", partial: { role: "assistant", content: [] } };
					yield { type: "done", reason: "stop", message: { role: "assistant", content: [], stopReason: "stop" } };
					return;
				}
				yield* successEvents();
			})();
		},
	});

	const events = await collect(rateLimitedStream(api, immediateLimiter(), undefined, {
		maxAttempts: 3,
		retryDelayMs: 0,
	})(model, context, {
		signal: controller.signal,
	}));

	expect(attempts).toBe(3);
	expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
	expect(events.at(-1)).toMatchObject({ type: "done" });
});

test("buffers content events until the provider emits done", async () => {
	let doneYielded = false;
	const api = () => ({
		streamSimple() {
			return (async function* () {
				const partial = { role: "assistant", content: [] };
				yield { type: "start", partial };
				await Bun.sleep(10);
				yield { type: "text_delta", contentIndex: 0, delta: "early", partial };
				await Bun.sleep(10);
				doneYielded = true;
				yield {
					type: "done",
					reason: "stop",
					message: { role: "assistant", content: [{ type: "text", text: "early" }], stopReason: "stop" },
				};
			})();
		},
	});
	const iterator = rateLimitedStream(api, immediateLimiter())(model, context)[Symbol.asyncIterator]();
	const firstPending = iterator.next();
	await Bun.sleep(5);

	expect(doneYielded).toBe(false);
	const first = await firstPending;
	const second = await iterator.next();

	expect(doneYielded).toBe(true);
	expect(first.value.type).toBe("start");
	expect(second.value).toMatchObject({ type: "text_delta", delta: "early" });
	await iterator.return?.();
});

test("forwards thinking start, delta, and end events for a valid response", async () => {
	const partial = { role: "assistant", content: [{ type: "thinking", thinking: "internal" }] };
	const api = () => ({
		streamSimple() {
			return (async function* () {
				yield { type: "start", partial: { role: "assistant", content: [] } };
				yield { type: "thinking_start", contentIndex: 0, partial };
				yield { type: "thinking_delta", contentIndex: 0, delta: "internal", partial };
				yield { type: "thinking_end", contentIndex: 0, content: "internal", partial };
				yield {
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "thinking", thinking: "internal" }, { type: "text", text: "answer" }],
						stopReason: "stop",
					},
				};
			})();
		},
	});
	const events = await collect(rateLimitedStream(api, immediateLimiter())(model, context));

	expect(events.map((event) => event.type)).toEqual([
		"start",
		"thinking_start",
		"thinking_delta",
		"thinking_end",
		"done",
	]);
});

test("retries an empty 2xx stream without exposing its start event", async () => {
	let attempts = 0;
	const api = () => ({
		streamSimple(_model, _context, options) {
			const attempt = attempts++;
			return (async function* () {
				await options.onResponse?.({ status: 200, headers: {} }, model);
				if (attempt === 0) {
					yield { type: "start", partial: { role: "assistant", content: [] } };
					yield {
						type: "done",
						reason: "stop",
						message: { role: "assistant", content: [], stopReason: "stop" },
					};
					return;
				}
				yield* successEvents();
			})();
		},
	});
	const events = await collect(rateLimitedStream(api, immediateLimiter(), undefined, {
		maxAttempts: 2,
		retryDelayMs: 0,
	})(model, context));

	expect(attempts).toBe(2);
	expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
	expect(events.find((event) => event.type === "start").partial.content).toEqual([]);
});

test("retries a start/text-start-only stream that closes before its first delta", async () => {
	let attempts = 0;
	const api = () => ({
		streamSimple(_model, _context, options) {
			const attempt = attempts++;
			return (async function* () {
				await options.onResponse?.({ status: 200, headers: {} }, model);
				if (attempt === 0) {
					const partial = { role: "assistant", content: [] };
					yield { type: "start", partial };
					yield { type: "text_start", contentIndex: 0, partial };
					return;
				}
				yield* successEvents();
			})();
		},
	});
	const events = await collect(rateLimitedStream(api, immediateLimiter(), undefined, {
		maxAttempts: 2,
		retryDelayMs: 0,
	})(model, context));

	expect(attempts).toBe(2);
	expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
});

test("retries empty thinking markers without exposing partial events", async () => {
	let attempts = 0;
	const api = () => ({
		streamSimple(_model, _context, options) {
			const attempt = attempts++;
			return (async function* () {
				await options.onResponse?.({ status: 200, headers: {} }, model);
				if (attempt === 0) {
					const partial = {
						role: "assistant",
						content: [{ type: "thinking", thinking: "" }],
					};
					yield { type: "start", partial };
					yield { type: "thinking_start", contentIndex: 0, partial };
					yield { type: "thinking_end", contentIndex: 0, content: "", partial };
					return;
				}
				yield* successEvents();
			})();
		},
	});
	const events = await collect(rateLimitedStream(api, immediateLimiter(), undefined, {
		maxAttempts: 2,
		retryDelayMs: 0,
	})(model, context));

	expect(attempts).toBe(2);
	expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
});

test("retries a 2xx stream truncated after content without duplicating partial output", async () => {
	let attempts = 0;
	const api = () => ({
		streamSimple(_model, _context, options) {
			const attempt = attempts++;
			return (async function* () {
				await options.onResponse?.({ status: 200, headers: {} }, model);
				if (attempt === 0) {
					const partial = { role: "assistant", content: [] };
					yield { type: "start", partial };
					yield { type: "text_delta", contentIndex: 0, delta: "partial", partial };
					// No terminal done: the provider closes the HTTP stream prematurely.
					return;
				}
				yield* successEvents();
			})();
		},
	});
	const events = await collect(rateLimitedStream(api, immediateLimiter(), undefined, {
		maxAttempts: 3,
		retryDelayMs: 0,
	})(model, context));

	expect(attempts).toBe(2);
	expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
	expect(events.at(1)).toMatchObject({ type: "text_delta", delta: "recovered" });
	expect(events.some((event) => event.delta === "partial")).toBe(false);
});

test("exhausts truncated streams after content without forwarding partial output", async () => {
	let attempts = 0;
	const api = () => ({
		streamSimple(_model, _context, options) {
			attempts += 1;
			return (async function* () {
				await options.onResponse?.({ status: 200, headers: {} }, model);
				const partial = { role: "assistant", content: [] };
				yield { type: "start", partial };
				yield { type: "text_delta", contentIndex: 0, delta: "partial", partial };
			})();
		},
	});
	const events = await collect(rateLimitedStream(api, immediateLimiter(), undefined, {
		maxAttempts: 2,
		retryDelayMs: 0,
	})(model, context));

	expect(attempts).toBe(2);
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({ type: "error", reason: "error" });
	expect(events[0].error.errorMessage).toContain("response validation budget exhausted");
	expect(JSON.stringify(events)).not.toContain("partial");
});

test("does not retry or diagnose a truncation when cancellation wins during retry delay", async () => {
	const controller = new AbortController();
	let attempts = 0;
	const api = () => ({
		streamSimple(_model, _context, options) {
			attempts += 1;
			return (async function* () {
				await options.onResponse?.({ status: 200, headers: {} }, model);
				const partial = { role: "assistant", content: [] };
				yield { type: "start", partial };
				yield { type: "text_delta", contentIndex: 0, delta: "partial", partial };
			})();
		},
	});
	const sessionId = `abort-during-truncation-${diagnosticNonce}`;
	const pending = collect(rateLimitedStream(api, immediateLimiter(), undefined, {
		maxAttempts: 3,
		retryDelayMs: 50,
	})(model, context, { signal: controller.signal, sessionId }));
	setTimeout(() => controller.abort(), 10);
	const events = await pending;

	expect(attempts).toBe(1);
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		type: "error",
		reason: "aborted",
		error: { stopReason: "aborted" },
	});
	expect(events[0].error.errorMessage).not.toContain("truncated");
	expect(JSON.stringify(events)).not.toContain("response validation");
	await Bun.sleep(10);
	const records = await diagnosticLines(testDiagnosticsPath, 0);
	expect(records.filter((entry) => entry.sessionId === sessionId)).toHaveLength(0);
});

test("treats an abort-shaped premature stream error as cancellation", async () => {
	let attempts = 0;
	const api = () => ({
		streamSimple(_model, _context, _options) {
			attempts += 1;
			return (async function* () {
				await _options.onResponse?.({ status: 200, headers: {} }, model);
				const partial = { role: "assistant", content: [] };
				yield { type: "start", partial };
				yield { type: "text_delta", contentIndex: 0, delta: "partial", partial };
				yield {
					type: "error",
					reason: "aborted",
					error: {
						role: "assistant",
						stopReason: "aborted",
						errorMessage: "Request was aborted",
					},
				};
			})();
		},
	});
	const events = await collect(rateLimitedStream(api, immediateLimiter(), undefined, {
		maxAttempts: 3,
		retryDelayMs: 0,
	})(model, context));

	expect(attempts).toBe(1);
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		type: "error",
		reason: "aborted",
		error: { stopReason: "aborted" },
	});
	expect(events[0].error.errorMessage).not.toContain("truncated");
});

test("treats an AbortError thrown by the inner stream as cancellation", async () => {
	let attempts = 0;
	const api = () => ({
		streamSimple(_model, _context, options) {
			attempts += 1;
			return (async function* () {
				await options.onResponse?.({ status: 200, headers: {} }, model);
				const partial = { role: "assistant", content: [] };
				yield { type: "start", partial };
				yield { type: "text_delta", contentIndex: 0, delta: "partial", partial };
				throw new DOMException("The operation was aborted.", "AbortError");
			})();
		},
	});
	const events = await collect(rateLimitedStream(api, immediateLimiter(), undefined, {
		maxAttempts: 3,
		retryDelayMs: 0,
	})(model, context));

	expect(attempts).toBe(1);
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		type: "error",
		reason: "aborted",
		error: { stopReason: "aborted" },
	});
	expect(events[0].error.errorMessage).not.toContain("truncated");
});

test("exhausts empty HTTP 2xx streams without forwarding partial events or looping", async () => {
	for (const invalidStream of ["empty", "truncated"]) {
		let attempts = 0;
		const api = () => ({
			streamSimple(_model, _context, options) {
				attempts += 1;
				return (async function* () {
					await options.onResponse?.({ status: 200, headers: {} }, model);
					if (invalidStream === "truncated") {
						yield { type: "start", partial: { role: "assistant", content: [] } };
					}
				})();
			},
		});

		const events = await collect(rateLimitedStream(api, immediateLimiter(), undefined, {
			maxAttempts: 2,
			retryDelayMs: 0,
		})(model, context));

		expect(attempts, invalidStream).toBe(2);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "error", reason: "error" });
		expect(events[0].error.errorMessage).toContain("response validation budget exhausted");
		expect(isRetryableAssistantError(events[0].error)).toBe(false);
		expect(isContextOverflow(events[0].error, 372_000)).toBe(false);
	}
});

test("bounds pi-ai premature stream errors after a successful response", async () => {
	const messages = [
		"Stream ended without finish_reason",
		"Stream ended before a terminal response event",
		"Stream ended before message_stop",
		"connection reset",
	];

	for (const errorMessage of messages) {
		let attempts = 0;
		let recordedFailures = 0;
		const limiter = {
			getState() { return undefined; },
			async wait() {},
			recordFailure() { recordedFailures += 1; },
			recordSuccess() { return false; },
		};
		const api = () => ({
			streamSimple(_model, _context, options) {
				attempts += 1;
				return (async function* () {
					await options.onResponse?.({ status: 200, headers: {} }, model);
					const partial = { role: "assistant", content: [] };
					yield { type: "start", partial };
					yield {
						type: "error",
						reason: "error",
						error: { role: "assistant", stopReason: "error", errorMessage },
					};
				})();
			},
		});

		const events = await collect(rateLimitedStream(api, limiter, undefined, {
			maxAttempts: 2,
			retryDelayMs: 0,
		})(model, context));

		expect(attempts, errorMessage).toBe(2);
		expect(recordedFailures, errorMessage).toBe(0);
		expect(events, errorMessage).toHaveLength(1);
		expect(events[0], errorMessage).toMatchObject({ type: "error", reason: "error" });
		expect(events[0].error.errorMessage, errorMessage).toContain("response validation budget exhausted");
		expect(isRetryableAssistantError(events[0].error), errorMessage).toBe(false);
		expect(isContextOverflow(events[0].error, 372_000), errorMessage).toBe(false);
	}
});

test("does not retry after a complete response even if an earlier transport callback was transient", async () => {
	let attempts = 0;
	const api = () => ({
		streamSimple(_model, _context, options) {
			attempts += 1;
			return (async function* () {
				await options.onResponse?.({ status: 503, headers: {} }, model);
				await options.onResponse?.({ status: 200, headers: {} }, model);
				yield* successEvents();
				yield {
					type: "error",
					reason: "error",
					error: { role: "assistant", stopReason: "error", errorMessage: "overloaded" },
				};
			})();
		},
	});
	const events = await collect(rateLimitedStream(api, immediateLimiter())(model, context));

	expect(attempts).toBe(1);
	expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
});

test("retries a 5xx even when the provider error body is not classifiable", async () => {
	let attempts = 0;
	const api = () => ({
		streamSimple(_model, _context, options) {
			const attempt = attempts++;
			return (async function* () {
				if (attempt === 0) {
					await options.onResponse?.({ status: 503, headers: {} }, model);
					yield {
						type: "error",
						reason: "error",
						error: { role: "assistant", stopReason: "error", errorMessage: "upstream unavailable" },
					};
					return;
				}
				await options.onResponse?.({ status: 200, headers: {} }, model);
				yield* successEvents();
			})();
		},
	});
	const events = await collect(rateLimitedStream(api, immediateLimiter())(model, context));

	expect(attempts).toBe(2);
	expect(events.at(-1)).toMatchObject({ type: "done" });
});

test("does not let a 400 body containing 429 override the HTTP status", async () => {
	let attempts = 0;
	const api = () => ({
		streamSimple(_model, _context, options) {
			attempts += 1;
			return (async function* () {
				await options.onResponse?.({ status: 400, headers: {} }, model);
				yield {
					type: "error",
					reason: "error",
					error: {
						role: "assistant",
						stopReason: "error",
						errorMessage: "429 The request could not be processed.",
					},
				};
			})();
		},
	});
	const controller = new AbortController();
	const pending = collect(rateLimitedStream(api, immediateLimiter())(model, context, { signal: controller.signal }));
	setTimeout(() => controller.abort(), 50);
	const events = await pending;

	expect(attempts).toBe(1);
	expect(events[0]).toMatchObject({ type: "error", reason: "error" });
});

test("forwards a complete tool call, including done, so Pi can execute it and continue", async () => {
	const toolCall = { type: "toolCall", id: "call-1", name: "exec_command", arguments: { cmd: "echo ok" } };
	const partial = { role: "assistant", content: [toolCall] };
	const api = () => ({
		streamSimple() {
			return (async function* () {
				yield { type: "start", partial };
				yield { type: "toolcall_start", contentIndex: 0, partial };
				yield { type: "toolcall_end", contentIndex: 0, toolCall, partial };
				yield { type: "done", reason: "toolUse", message: { ...partial, stopReason: "toolUse" } };
			})();
		},
	});
	const events = await collect(rateLimitedStream(api, immediateLimiter())(model, context));

	expect(events.map((event) => event.type)).toEqual(["start", "toolcall_start", "toolcall_end", "done"]);
	expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
});
