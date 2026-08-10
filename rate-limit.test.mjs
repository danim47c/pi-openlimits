import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isOpenLimitsRateLimit,
	OpenLimitsRateLimiter,
	parseRetryAfter,
} from "./rate-limit.ts";

const directories = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function limiterPair(now = () => Date.now(), cooldownMs) {
	const directory = await mkdtemp(join(tmpdir(), "pi-openlimits-rate-limit-"));
	directories.push(directory);
	const statePath = join(directory, "state.json");
	return [
		new OpenLimitsRateLimiter({ statePath, now, cooldownMs }),
		new OpenLimitsRateLimiter({ statePath, now, cooldownMs }),
	];
}

async function expectAbort(promise) {
	const controller = new AbortController();
	const pending = promise(controller.signal);
	setTimeout(() => controller.abort(), 10);
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
}

async function persistedState(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(`Could not read persisted rate-limit state: ${error}`);
	}
}

describe("OpenLimits rate limit circuit breaker", () => {
	test("opens after the first 429 and is shared by instances", async () => {
		const now = () => 1_000;
		const [first, second] = await limiterPair(now);
		await first.record429();
		await expectAbort((signal) => second.acquire(signal));
		const state = await persistedState(first.statePath);
		expect(state.openUntil).toBe(61_000);
	});

	test("resets the consecutive 429 count after a non-429 failure", async () => {
		const [limiter] = await limiterPair(() => 1_000, 0);
		await limiter.record429();
		await limiter.recordNon429Failure();
		await limiter.record429();
		expect((await persistedState(limiter.statePath)).consecutive429).toBe(1);
	});

	test("allows one half-open probe, resets on success, and reopens on its 429", async () => {
		let time = 1_000;
		const now = () => time;
		const [first, second] = await limiterPair(now);
		await first.record429();
		time += 120_000;
		await first.acquire();
		await expectAbort((signal) => second.acquire(signal));
		await first.recordSuccess();
		await second.acquire();
		await first.record429();
		time += 120_000;
		await first.acquire();
		await expectAbort((signal) => second.acquire(signal));
	});

	test("keeps the largest Retry-After and never shortens an open circuit", async () => {
		let time = 1_000;
		const [limiter] = await limiterPair(() => time);
		await limiter.record429(120_000);
		time += 1_000;
		await limiter.record429();
		time += 1_000;
		await limiter.record429();
		const initial = await persistedState(limiter.statePath);
		expect(initial.openUntil).toBe(time + 120_000);
		time += 1_000;
		await limiter.record429();
		const updated = await persistedState(limiter.statePath);
		expect(updated.openUntil).toBeGreaterThanOrEqual(initial.openUntil);
	});

	test("recovers a stale lock directory", async () => {
		const [limiter] = await limiterPair();
		const lockPath = `${limiter.statePath}.lock`;
		await mkdir(lockPath);
		const stale = new Date(Date.now() - 10 * 60_000);
		await utimes(lockPath, stale, stale);
		await limiter.acquire();
	});

	test("fails open within a bounded wait for a fresh orphaned lock", async () => {
		const [limiter] = await limiterPair();
		await mkdir(`${limiter.statePath}.lock`);
		const started = Date.now();
		await limiter.acquire();
		expect(Date.now() - started).toBeLessThan(600);
	});

	test("aborts promptly while waiting for a fresh lock", async () => {
		const [limiter] = await limiterPair();
		await mkdir(`${limiter.statePath}.lock`);
		await expectAbort((signal) => limiter.acquire(signal));
	});

	test("fails open when the lock parent is not writable as a directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-openlimits-rate-limit-"));
		directories.push(directory);
		const parent = join(directory, "not-a-directory");
		await writeFile(parent, "x");
		const limiter = new OpenLimitsRateLimiter({ statePath: join(parent, "state.json") });
		await expect(limiter.record429()).resolves.toBeUndefined();
		await expect(limiter.recordSuccess()).resolves.toBeUndefined();
		await expect(limiter.acquire()).resolves.toEqual({});
	});

	test("parses Retry-After seconds and dates", () => {
		expect(parseRetryAfter("75", 1_000)).toBe(75_000);
		expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:03 GMT", 1_000)).toBe(2_000);
		expect(parseRetryAfter("invalid")).toBeUndefined();
	});

	test("classifies only the observed bare 429 message", () => {
		const observed = {
			role: "assistant",
			stopReason: "error",
			errorMessage: "429 The request could not be processed.",
		};
		expect(isOpenLimitsRateLimit(observed)).toBe(true);
		expect(isOpenLimitsRateLimit({
			...observed,
			errorMessage: '429: {"message":"The request could not be processed.","type":"rate_limit_error","code":429}',
		})).toBe(true);
		expect(
			isOpenLimitsRateLimit({
				...observed,
				errorMessage: "OpenAI API error (429)",
			}),
		).toBe(false);
		expect(isOpenLimitsRateLimit({ ...observed, stopReason: "stop" })).toBe(
			false,
		);
	});
});
