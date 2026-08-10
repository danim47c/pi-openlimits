import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	DEFAULT_RATE_LIMIT_COOLDOWN_MS,
	OpenLimitsRateLimiter,
	type RateLimitLease,
} from "./rate-limit.ts";

export type TransientKind = "rate_limit" | "overloaded";

const RATE_LIMIT_WAIT_MS = DEFAULT_RATE_LIMIT_COOLDOWN_MS;
const OVERLOADED_WAIT_MS = 5_000;

type SessionState = {
	kind: TransientKind;
	blockedAt: number;
	blockedUntil: number;
	recoverySignalAt?: number;
};

type RateLimitFailure = {
	sessionId: string;
	requestCount: number;
	firstFailedAt: string;
	lastFailedAt: string;
	kind: "rate_limit" | "overloaded";
	sampleMessage?: string;
};

export type TransientRecoveryOptions = {
	/** Shared circuit used by independent Pi/subagent processes. */
	sharedLimiter?: OpenLimitsRateLimiter;
};

/**
 * Per-process session gates plus an optional cross-process OpenLimits circuit.
 * The local gate keeps one stream from spinning; the shared limiter prevents
 * every subagent process from issuing the same request burst after a 429.
 */
export class OpenLimitsTransientRecovery {
	private readonly sessions = new Map<string, SessionState>();
	private readonly waiters = new Set<() => void>();
	private generation = 0;
	private readonly transientFailures = new Map<string, RateLimitFailure>();
	private legacyFailures: RateLimitFailure[] = [];
	private logLoaded?: Promise<void>;
	private readonly recoveryPath = join(homedir(), ".pi", "agent", "openlimits-recovered");
	private readonly rateLimitLogPath = join(homedir(), ".pi", "agent", "openlimits-rate-limit.json");
	private readonly sharedLimiter?: OpenLimitsRateLimiter;
	private readonly sharedLeases = new Map<string, RateLimitLease>();
	private sharedUpdate: Promise<void> = Promise.resolve();

	constructor(options: TransientRecoveryOptions = {}) {
		this.sharedLimiter = options.sharedLimiter;
	}

	async wait(sessionId: string, signal?: AbortSignal): Promise<void> {
		if (this.sharedLimiter) {
			// recordFailure/recordSuccess are intentionally synchronous at this
			// layer so the provider stream cannot be blocked on diagnostics. Flush
			// their ordered persistence before acquiring the next shared lease.
			await this.sharedUpdate;
			this.sharedLeases.set(sessionId, await this.sharedLimiter.acquire(signal));
		}
		for (;;) {
			if (signal?.aborted) throw abortError();
			const state = this.sessions.get(sessionId);
			if (!state) return;
			const recoverySignalAt = await this.recoverySignalMtime();
			if (recoverySignalAt !== undefined && recoverySignalAt > (state.recoverySignalAt ?? state.blockedAt)) {
				// A recovery marker is only a permission to probe this session. Keep
				// its circuit until the probe itself succeeds, and remember the marker
				// so the same signal cannot trigger an unbounded request loop.
				state.recoverySignalAt = recoverySignalAt;
				return;
			}
			const now = Date.now();
			const remaining = state.blockedUntil - now;
			if (remaining <= 0) return;
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				let unregister = () => {};
				const finish = (error?: Error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					unregister();
					signal?.removeEventListener("abort", onAbort);
					if (error) reject(error); else resolve();
				};
				const timer = setTimeout(finish, Math.min(remaining, 1_000));
				const onAbort = () => finish(abortError());
				unregister = this.addWaiter(finish);
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
	}

	recordFailure(sessionId: string, kind: TransientKind, retryAfterMs?: number, sample?: string): void {
		const now = Date.now();
		const wait = kind === "rate_limit"
			? Math.max(RATE_LIMIT_WAIT_MS, retryAfterMs ?? 0)
			: OVERLOADED_WAIT_MS;
		this.sessions.set(sessionId, { kind, blockedAt: now, blockedUntil: now + wait });
		if (this.sharedLimiter && kind === "rate_limit") {
			this.sharedLeases.delete(sessionId);
			this.enqueueShared(() => this.sharedLimiter!.record429(retryAfterMs));
		}
		void this.recordTransientFailure(sessionId, kind, now, sample ?? "");
	}

	recordSuccess(sessionId: string): boolean {
		const hadBlockedSession = this.sessions.size > 0;
		const ownStateWasCleared = this.sessions.delete(sessionId);
		const otherSessionIsBlocked = this.sessions.size > 0;
		if (hadBlockedSession) {
			this.generation++;
			for (const wake of this.waiters) wake();
		}
		if (hadBlockedSession) void this.publishRecovery();
		if (this.sharedLimiter) {
			const lease = this.sharedLeases.get(sessionId);
			this.sharedLeases.delete(sessionId);
			this.enqueueShared(() => this.sharedLimiter!.recordSuccess(undefined, lease));
		}
		// A success is a global wake/probe signal, not permission to clear
		// another session's circuit. That session must probe and re-classify its
		// own next response.
		return !ownStateWasCleared && otherSessionIsBlocked;
	}

	getState(sessionId: string): SessionState | undefined {
		const state = this.sessions.get(sessionId);
		return state ? { ...state } : undefined;
	}

	addWaiter(wake: () => void): () => void {
		this.waiters.add(wake);
		return () => this.waiters.delete(wake);
	}

	private enqueueShared(update: () => Promise<void>): void {
		this.sharedUpdate = this.sharedUpdate.then(update, update).catch(() => {
			// Persistence is best effort; a later request can still proceed.
		});
	}

	private async recoverySignalMtime(): Promise<number | undefined> {
		try {
			return (await stat(this.recoveryPath)).mtimeMs;
		} catch {
			return undefined;
		}
	}


	private async recordTransientFailure(
		sessionId: string,
		kind: "rate_limit" | "overloaded",
		now: number,
		sample: string,
	): Promise<void> {
		this.logLoaded ??= this.loadRateLimitLog();
		await this.logLoaded;
		const timestamp = new Date(now).toISOString();
		const key = `${sessionId}\u0000${kind}`;
		const previous = this.transientFailures.get(key);
		this.transientFailures.set(key, {
			sessionId,
			kind,
			requestCount: (previous?.requestCount ?? 0) + 1,
			firstFailedAt: previous?.firstFailedAt ?? timestamp,
			lastFailedAt: timestamp,
			sampleMessage: previous?.sampleMessage ?? sample.slice(0, 200),
		});
		await this.persistRateLimitLog();
	}

	private async loadRateLimitLog(): Promise<void> {
		try {
			const parsed = JSON.parse(await readFile(this.rateLimitLogPath, "utf8")) as {
				schemaVersion?: number;
				sessions?: RateLimitFailure[];
			};
			if (parsed.schemaVersion !== 2) {
				this.legacyFailures = parsed.sessions ?? [];
				return;
			}
			for (const entry of parsed.sessions ?? []) {
				if (
					typeof entry.sessionId === "string" &&
					typeof entry.requestCount === "number" &&
					(entry.kind === "rate_limit" || entry.kind === "overloaded")
				) {
					this.transientFailures.set(`${entry.sessionId}\u0000${entry.kind}`, entry);
				}
			}
		} catch {
			// Missing or legacy diagnostics start a fresh structured log.
		}
	}

	private async persistRateLimitLog(): Promise<void> {
		try {
			await mkdir(dirname(this.rateLimitLogPath), { recursive: true });
			const sessions = [...this.transientFailures.values()];
			const payload = {
				schemaVersion: 2,
				updatedAt: new Date().toISOString(),
				total429Requests: sessions
					.filter((entry) => entry.kind === "rate_limit")
					.reduce((total, entry) => total + entry.requestCount, 0),
				totalOverloadedRequests: sessions
					.filter((entry) => entry.kind === "overloaded")
					.reduce((total, entry) => total + entry.requestCount, 0),
				sessions,
				...(this.legacyFailures.length ? { legacySessions: this.legacyFailures } : {}),
			};
			const temporary = `${this.rateLimitLogPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
			try {
				await writeFile(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 });
				await rename(temporary, this.rateLimitLogPath);
			} finally {
				await rm(temporary, { force: true }).catch(() => {});
			}
		} catch {
			// Diagnostics are best effort and must never affect a session.
		}
	}

	private async publishRecovery(): Promise<void> {
		try {
			await mkdir(dirname(this.recoveryPath), { recursive: true });
			const temporary = `${this.recoveryPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
			try {
				await writeFile(temporary, String(Date.now()), { mode: 0o600 });
				await rename(temporary, this.recoveryPath);
			} finally {
				await rm(temporary, { force: true }).catch(() => {});
			}
		} catch {
			// Cross-process wakeup is best effort and must never affect a session.
		}
	}
}

function abortError(): Error {
	return new DOMException("The operation was aborted.", "AbortError");
}
