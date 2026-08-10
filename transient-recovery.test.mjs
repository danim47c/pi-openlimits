import { describe, expect, test } from "bun:test";
import { OpenLimitsTransientRecovery } from "./transient-recovery.ts";

describe("per-session transient recovery", () => {
  test("a 429 blocks only the session that received it for one minute", () => {
    const recovery = new OpenLimitsTransientRecovery();
    const before = Date.now();
    recovery.recordFailure("session-a", "rate_limit");
    const blocked = recovery.getState("session-a");
    expect(blocked.kind).toBe("rate_limit");
    expect(blocked.blockedUntil).toBeGreaterThanOrEqual(before + 60_000);
    expect(recovery.getState("session-b")).toBeUndefined();
  });

test("overloaded uses a fixed five-second delay and success is globally observable", () => {
    const recovery = new OpenLimitsTransientRecovery();
    const before = Date.now();
	recovery.recordFailure("session-a", "overloaded");
	const blocked = recovery.getState("session-a");
	expect(blocked.blockedUntil).toBeGreaterThanOrEqual(before + 5_000);
	expect(blocked.blockedUntil).toBeLessThan(before + 6_000);
	expect(recovery.recordSuccess("session-b")).toBe(true);
	// The global signal wakes/probes session-a; it must not erase its own
	// circuit before that session gets a successful response.
	expect(recovery.getState("session-a")).toMatchObject({ kind: "overloaded" });
	expect(recovery.recordSuccess("session-a")).toBe(false);
	expect(recovery.getState("session-a")).toBeUndefined();
});

});
