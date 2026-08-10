import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The minimum time a shared OpenLimits circuit stays open after a 429. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 1_000;
const LOCK_WAIT_MS = 250;

export interface RateLimitState {
	consecutive429: number;
	openUntil: number;
	probeUntil: number;
	retryAfterMs: number;
	/** Only the process that owns this token may close a half-open circuit. */
	probeOwner?: string;
}

/** The lease returned by acquire; an ordinary request has no probe token. */
export interface RateLimitLease {
	probeToken?: string;
}

const EMPTY_STATE: RateLimitState = {
	consecutive429: 0,
	openUntil: 0,
	probeUntil: 0,
	retryAfterMs: 0,
};

export function parseRetryAfter(
	value: string | null | undefined,
	now = Date.now(),
): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function isOpenLimitsRateLimit(
	message: unknown,
	provider?: string,
	api?: string,
): boolean {
	if (typeof message !== "object" || message === null) return false;
	const candidate = message as {
		role?: unknown;
		stopReason?: unknown;
		errorMessage?: unknown;
		provider?: unknown;
		api?: unknown;
	};
	if (
		candidate.role !== "assistant" ||
		candidate.stopReason !== "error" ||
		typeof candidate.errorMessage !== "string"
	)
		return false;
	if (provider && candidate.provider !== undefined && candidate.provider !== provider)
		return false;
	if (api && candidate.api !== undefined && candidate.api !== api) return false;
	const text = candidate.errorMessage;
	if (!/(?<!\d)429(?!\d)/.test(text)) return false;
	return (
		text.includes("The request could not be processed.") ||
		text.includes("rate_limit_error")
	);
}

function parseState(value: string): RateLimitState {
	try {
		const state = JSON.parse(value) as Partial<RateLimitState>;
		if (
			typeof state.consecutive429 !== "number" ||
			!Number.isFinite(state.consecutive429) ||
			typeof state.openUntil !== "number" ||
			!Number.isFinite(state.openUntil) ||
			typeof state.probeUntil !== "number" ||
			!Number.isFinite(state.probeUntil)
		)
			return { ...EMPTY_STATE };
		return {
			consecutive429: Math.max(0, state.consecutive429),
			openUntil: Math.max(0, state.openUntil),
			probeUntil: Math.max(0, state.probeUntil),
			retryAfterMs:
				typeof state.retryAfterMs === "number" && Number.isFinite(state.retryAfterMs)
					? Math.max(0, state.retryAfterMs)
					: 0,
			...(typeof state.probeOwner === "string" ? { probeOwner: state.probeOwner } : {}),
		};
	} catch {
		return { ...EMPTY_STATE };
	}
}

function abortError(): Error {
	return new DOMException("The operation was aborted.", "AbortError");
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

/**
 * A small file-backed circuit breaker. Pi starts each subagent in a separate
 * process, so an in-memory gate cannot stop every worker from sending the same
 * request burst after the first 429.
 */
export class OpenLimitsRateLimiter {
	readonly statePath: string;
	private readonly lockPath: string;
	private readonly now: () => number;
	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly cooldownMs: number;
	private readonly instanceId = `${process.pid}.${Math.random().toString(36).slice(2)}`;
	private readonly ownedProbeTokens = new Set<string>();

	constructor(
		options: {
			statePath?: string;
			now?: () => number;
			sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
			cooldownMs?: number;
		} = {},
	) {
		// Keep this separate from transient-recovery's human-readable diagnostics
		// file. Older versions used the same path and consequently parsed the
		// diagnostics object as an empty circuit on every request.
		this.statePath =
			options.statePath ??
			process.env.OPENLIMITS_RATE_LIMIT_STATE_PATH ??
			join(homedir(), ".pi", "agent", "openlimits-rate-limit-circuit.json");
		this.lockPath = `${this.statePath}.lock`;
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? sleep;
		this.cooldownMs = Math.max(
			0,
			options.cooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
		);
	}

	/** Wait until this process may issue a request and return its probe lease. */
	async acquire(signal?: AbortSignal): Promise<RateLimitLease> {
		try {
			for (;;) {
				if (signal?.aborted) throw abortError();
				const release = await this.lock(signal);
				if (!release) return {};
				let delay = 0;
				try {
					const state = await this.readState(signal);
					const now = this.now();
					if (state.openUntil > now) {
						delay = state.openUntil - now;
					} else if (state.probeUntil > now) {
						// Another process owns the half-open probe. Re-check in a
						// short interval so cancellation stays responsive.
						delay = Math.min(state.probeUntil - now, 1_000);
					} else if (state.openUntil > 0) {
						// Permit exactly one probe after the cooldown. A successful
						// probe clears the circuit; a 429 re-opens it.
						const probeToken = `${this.instanceId}.${Math.random().toString(36).slice(2)}`;
						state.probeUntil = now + this.cooldownMs;
						state.probeOwner = probeToken;
						await this.writeState(state, signal);
						this.ownedProbeTokens.add(probeToken);
						return { probeToken };
					} else {
						return {};
					}
				} finally {
					await release();
				}
				await this.sleep(delay, signal);
			}
		} catch (error) {
			if (signal?.aborted || isAbort(error)) throw error;
			// Coordination is best effort. A broken diagnostics directory must
			// never prevent a provider request from being attempted.
			return {};
		}
	}

	/** Open the shared circuit immediately after a 429. */
	async record429(
		retryAfterMs?: number,
		signal?: AbortSignal,
		_lease?: RateLimitLease,
	): Promise<void> {
		await this.update((state, now) => {
			state.consecutive429 += 1;
			state.retryAfterMs = Math.max(state.retryAfterMs, retryAfterMs ?? 0);
			state.openUntil = Math.max(
				state.openUntil,
				now + Math.max(this.cooldownMs, state.retryAfterMs),
			);
			state.probeUntil = 0;
			delete state.probeOwner;
			return state;
		}, signal);
		this.ownedProbeTokens.clear();
	}

	/**
	 * Clear a circuit only when this caller owns the half-open probe. A normal
	 * in-flight request finishing after another process's 429 must not reopen a
	 * stampede by clearing the shared state.
	 */
	async recordSuccess(
		signal?: AbortSignal,
		lease?: RateLimitLease,
	): Promise<void> {
		let probeToken = lease?.probeToken;
		if (!probeToken) probeToken = this.ownedProbeTokens.values().next().value;
		await this.update((state, now) => {
			if (probeToken && state.probeOwner === probeToken) return { ...EMPTY_STATE };
			if (state.openUntil <= now && state.probeUntil <= now) return { ...EMPTY_STATE };
			return state;
		}, signal);
		if (probeToken) this.ownedProbeTokens.delete(probeToken);
	}

	/** Reset the consecutive count after a non-transient response, if closed. */
	async recordNon429Failure(signal?: AbortSignal): Promise<void> {
		await this.update((state, now) => {
			if (state.openUntil <= now && state.probeUntil <= now) {
				state.consecutive429 = 0;
				state.retryAfterMs = 0;
				delete state.probeOwner;
			}
			return state;
		}, signal);
	}

	private async update(
		change: (state: RateLimitState, now: number) => RateLimitState,
		signal?: AbortSignal,
	): Promise<void> {
		try {
			const release = await this.lock(signal);
			if (!release) return;
			try {
				await this.writeState(
					change(await this.readState(signal), this.now()),
					signal,
				);
			} finally {
				await release();
			}
		} catch (error) {
			if (signal?.aborted || isAbort(error)) throw error;
			// Fail open when persistence is unavailable; the upstream response
			// still determines whether the request succeeds.
		}
	}

	private async lock(
		signal?: AbortSignal,
	): Promise<(() => Promise<void>) | undefined> {
		try {
			await this.bounded(
				mkdir(dirname(this.statePath), { recursive: true }),
				LOCK_WAIT_MS,
				signal,
			);
		} catch (error) {
			if (signal?.aborted || isAbort(error)) throw error;
			return undefined;
		}
		const deadline = Date.now() + LOCK_WAIT_MS;
		for (;;) {
			if (signal?.aborted) throw abortError();
			try {
				const remaining = deadline - Date.now();
				if (remaining <= 0) return undefined;
				await this.bounded(mkdir(this.lockPath), remaining, signal);
				const token = `${this.instanceId}.${Math.random().toString(36).slice(2)}`;
				try {
					await this.bounded(
						writeFile(join(this.lockPath, "owner"), token, { mode: 0o600 }),
						LOCK_WAIT_MS,
						signal,
					);
				} catch (error) {
					void rm(this.lockPath, { recursive: true, force: true }).catch(() => {});
					if (signal?.aborted || isAbort(error)) throw error;
					return undefined;
				}
				return async () => {
					try {
						const owner = await this.bounded(
							readFile(join(this.lockPath, "owner"), "utf8"),
							LOCK_WAIT_MS,
						);
						if (owner === token)
							await this.bounded(
								rm(this.lockPath, { recursive: true, force: true }),
								LOCK_WAIT_MS,
							);
					} catch {
						// Never remove a lock whose ownership cannot be confirmed.
					}
				};
			} catch (error) {
				if (signal?.aborted || isAbort(error)) throw error;
				if (
					!(error instanceof Error) ||
					!("code" in error) ||
					error.code !== "EEXIST"
				)
					return undefined;
				await this.recoverStaleLock();
				const remaining = deadline - Date.now();
				if (remaining <= 0) return undefined;
				await this.sleep(Math.min(LOCK_RETRY_MS, remaining), signal);
			}
		}
	}

	private async recoverStaleLock(): Promise<void> {
		try {
			const lockStat = await this.bounded(
				stat(this.lockPath),
				LOCK_WAIT_MS,
			);
			if (Date.now() - lockStat.mtimeMs < LOCK_STALE_MS) return;
			let owner: string | undefined;
			try {
				owner = await this.bounded(
					readFile(join(this.lockPath, "owner"), "utf8"),
					LOCK_WAIT_MS,
				);
			} catch {
				// A lock without an owner is recoverable after the stale interval.
			}
			const ownerPid = Number(owner?.split(".")[0]);
			if (Number.isInteger(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid)) return;
			const recoveredPath = `${this.lockPath}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
			await this.bounded(rename(this.lockPath, recoveredPath), LOCK_WAIT_MS);
			await this.bounded(rm(recoveredPath, { recursive: true, force: true }), LOCK_WAIT_MS);
		} catch {
			// Another process won the race or the filesystem is unavailable.
		}
	}

	private async readState(signal?: AbortSignal): Promise<RateLimitState> {
		try {
			return parseState(
				await this.bounded(readFile(this.statePath, "utf8"), LOCK_WAIT_MS, signal),
			);
		} catch (error) {
			if (signal?.aborted || isAbort(error)) throw error;
			return { ...EMPTY_STATE };
		}
	}

	private async writeState(state: RateLimitState, signal?: AbortSignal): Promise<void> {
		const temporary = `${this.statePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		try {
			await this.bounded(
				writeFile(temporary, JSON.stringify(state), { mode: 0o600 }),
				LOCK_WAIT_MS,
				signal,
			);
			await this.bounded(rename(temporary, this.statePath), LOCK_WAIT_MS, signal);
		} finally {
			await rm(temporary, { force: true }).catch(() => {});
		}
	}

	private bounded<T>(
		operation: Promise<T>,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<T> {
		if (signal?.aborted) return Promise.reject(abortError());
		return new Promise((resolve, reject) => {
			let settled = false;
			const timeout = setTimeout(
				() => done(new Error("Rate-limit filesystem operation timed out.")),
				timeoutMs,
			);
			const onAbort = () => done(abortError());
			const done = (error?: unknown, result?: T) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve(result as T);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			operation.then((result) => done(undefined, result), done);
		});
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(done, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			done(abortError());
		};
		function done(error?: Error): void {
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
