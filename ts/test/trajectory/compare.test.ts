import { describe, it, expect } from "vitest";
import { compareTrajectories } from "../../src/trajectory/compare.js";
import { TrajectoryStep } from "../../src/trajectory/types.js";

function step(index: number, method: string, toolName?: string, params: Record<string, unknown> = {}): TrajectoryStep {
    return { index, method, toolName, params: toolName ? { name: toolName, ...params } : params, frameIndex: index, tMs: index };
}

describe("compareTrajectories -- strict mode", () => {
    it("passes when golden and actual are identical", () => {
        const golden = [step(0, "tools/list"), step(1, "tools/call", "search", { q: "a" })];
        const actual = [step(0, "tools/list"), step(1, "tools/call", "search", { q: "a" })];

        const report = compareTrajectories(golden, actual);
        expect(report.summary.passed).toBe(true);
        expect(report.summary.exact).toBe(2);
        expect(report.steps.map((s) => s.outcome)).toEqual(["exact", "exact"]);
    });

    it("fails and reports an added step for an extra actual tool call", () => {
        const golden = [step(0, "tools/call", "search", { q: "a" })];
        const actual = [step(0, "tools/call", "search", { q: "a" }), step(1, "tools/call", "send_email", { to: "x" })];

        const report = compareTrajectories(golden, actual);
        expect(report.summary.passed).toBe(false);
        expect(report.summary.added).toBe(1);
        const added = report.steps.find((s) => s.outcome === "added");
        expect(added).toMatchObject({ actualIndex: 1, toolName: "send_email" });
    });

    it("fails and reports a missing step for an omitted golden call", () => {
        const golden = [step(0, "tools/call", "search", { q: "a" }), step(1, "tools/call", "confirm")];
        const actual = [step(0, "tools/call", "search", { q: "a" })];

        const report = compareTrajectories(golden, actual);
        expect(report.summary.passed).toBe(false);
        expect(report.summary.missing).toBe(1);
        expect(report.steps.find((s) => s.outcome === "missing")).toMatchObject({ goldenIndex: 1, toolName: "confirm" });
    });

    it("never bridges two tool names, even structurally close (F3 hard gate)", () => {
        const golden = [step(0, "tools/call", "delete_file", { path: "/tmp/x" })];
        const actual = [step(0, "tools/call", "read_file", { path: "/tmp/x" })];

        const report = compareTrajectories(golden, actual);
        expect(report.steps).toHaveLength(2);
        expect(report.steps.map((s) => s.outcome).sort()).toEqual(["added", "missing"]);
    });

    it("consumes each duplicate call once (2 golden vs 1 actual leaves 1 missing)", () => {
        const golden = [step(0, "tools/call", "search", { q: "a" }), step(1, "tools/call", "search", { q: "a" })];
        const actual = [step(0, "tools/call", "search", { q: "a" })];

        const report = compareTrajectories(golden, actual);
        expect(report.summary.exact).toBe(1);
        expect(report.summary.missing).toBe(1);
    });

    it("treats a score exactly at threshold as tolerated (inclusive), passing overall", () => {
        const golden = [step(0, "tools/call", "search", { q: "aaaa" })];
        const actual = [step(0, "tools/call", "search", { q: "aaab" })];

        const withLowThreshold = compareTrajectories(golden, actual, { threshold: 0 });
        expect(withLowThreshold.summary.passed).toBe(true);
        expect(["exact", "tolerated"]).toContain(withLowThreshold.steps[0].outcome);
    });

    it("fails on a drifted match below threshold", () => {
        const golden = [step(0, "tools/call", "search", { q: "totally different topic entirely" })];
        const actual = [step(0, "tools/call", "search", { q: "zzz" })];

        const report = compareTrajectories(golden, actual, { threshold: 0.99 });
        expect(report.summary.passed).toBe(false);
        expect(report.summary.drifted).toBe(1);
        expect(report.steps[0]).toMatchObject({ goldenIndex: 0, actualIndex: 0, outcome: "drifted" });
    });
});

describe("compareTrajectories -- strict mode reorder classification", () => {
    it("merges a swapped pair of calls into one reordered entry instead of disconnected added/missing", () => {
        const golden = [step(0, "tools/call", "lookup_customer"), step(1, "tools/call", "issue_refund")];
        const actual = [step(0, "tools/call", "issue_refund"), step(1, "tools/call", "lookup_customer")];

        const report = compareTrajectories(golden, actual);
        expect(report.summary.passed).toBe(false);
        expect(report.summary.reordered).toBe(1);
        expect(report.summary.exact).toBe(1);
        expect(report.summary.added).toBe(0);
        expect(report.summary.missing).toBe(0);
        expect(report.steps).toHaveLength(2);
        expect(report.steps.find((s) => s.toolName === "issue_refund")).toMatchObject({
            goldenIndex: 1,
            actualIndex: 0,
            outcome: "reordered",
            score: 1,
        });
    });

    it("does not merge an added and a missing call to different tools", () => {
        const golden = [step(0, "tools/call", "lookup_customer")];
        const actual = [step(0, "tools/call", "send_email")];

        const report = compareTrajectories(golden, actual);
        expect(report.summary.reordered).toBe(0);
        expect(report.summary.added).toBe(1);
        expect(report.summary.missing).toBe(1);
    });

    it("does not merge a same-tool pair whose arguments score below threshold", () => {
        // A second, unrelated exact match (lookup_customer) is what makes the DP leave the
        // low-scoring "search" pair disconnected rather than matching it directly in place --
        // with only one step per side there'd be nothing to strand by matching it anyway.
        const golden = [step(0, "tools/call", "lookup_customer"), step(1, "tools/call", "search", { q: "quarterly earnings report" })];
        const actual = [step(0, "tools/call", "search", { q: "completely unrelated weather forecast" }), step(1, "tools/call", "lookup_customer")];

        const report = compareTrajectories(golden, actual, { threshold: 0.99 });
        expect(report.summary.reordered).toBe(0);
        expect(report.summary.added).toBe(1);
        expect(report.summary.missing).toBe(1);
        expect(report.summary.exact).toBe(1);
    });
});

describe("compareTrajectories -- unordered mode", () => {
    it("passes for a reordered but identical multiset of calls", () => {
        const golden = [step(0, "tools/call", "a"), step(1, "tools/call", "b")];
        const actual = [step(0, "tools/call", "b"), step(1, "tools/call", "a")];

        const report = compareTrajectories(golden, actual, { mode: "unordered" });
        expect(report.summary.passed).toBe(true);
        expect(report.summary.exact).toBe(2);
    });

    it("fails when a golden call has no counterpart, regardless of order", () => {
        const golden = [step(0, "tools/call", "a"), step(1, "tools/call", "a")];
        const actual = [step(0, "tools/call", "a")];

        const report = compareTrajectories(golden, actual, { mode: "unordered" });
        expect(report.summary.passed).toBe(false);
        expect(report.summary.missing).toBe(1);
    });
});

describe("compareTrajectories -- subset mode", () => {
    it("tolerates an omitted golden step but fails on an unmatched actual step", () => {
        const golden = [step(0, "tools/call", "a"), step(1, "tools/call", "b")];

        const omitting = compareTrajectories(golden, [step(0, "tools/call", "a")], { mode: "subset" });
        expect(omitting.summary.passed).toBe(true);
        expect(omitting.summary.missing).toBe(1);

        const adding = compareTrajectories(golden, [...golden, step(2, "tools/call", "c")], { mode: "subset" });
        expect(adding.summary.passed).toBe(false);
        expect(adding.summary.added).toBe(1);
    });
});

describe("compareTrajectories -- superset mode", () => {
    it("tolerates an added actual step but fails on a missing golden step", () => {
        const golden = [step(0, "tools/call", "a")];

        const adding = compareTrajectories(golden, [...golden, step(1, "tools/call", "b")], { mode: "superset" });
        expect(adding.summary.passed).toBe(true);
        expect(adding.summary.added).toBe(1);

        const omitting = compareTrajectories(golden, [], { mode: "superset" });
        expect(omitting.summary.passed).toBe(false);
        expect(omitting.summary.missing).toBe(1);
    });
});

describe("compareTrajectories -- policy mode", () => {
    it("passes when every required matcher is satisfied and nothing prohibited appears", () => {
        const actual = [step(0, "tools/call", "lookup_customer"), step(1, "tools/call", "issue_refund")];

        const report = compareTrajectories([], actual, {
            mode: "policy",
            policy: {
                policyVersion: 1,
                required: [{ method: "tools/call", toolName: "lookup_customer" }],
                prohibited: [{ method: "tools/call", toolName: "issue_refund", argsMatch: { without_validation: true } }],
            },
        });

        expect(report.summary.passed).toBe(true);
        expect(report.summary.requiredMissing).toBe(0);
        expect(report.summary.prohibitedPresent).toBe(0);
    });

    it("fails when a required step never appears", () => {
        const report = compareTrajectories([], [step(0, "tools/call", "lookup_customer")], {
            mode: "policy",
            policy: { policyVersion: 1, required: [{ method: "tools/call", toolName: "issue_refund" }] },
        });

        expect(report.summary.passed).toBe(false);
        expect(report.summary.requiredMissing).toBe(1);
        expect(report.steps[0]).toMatchObject({ outcome: "required-missing" });
    });

    it("fails when a prohibited step is present, regardless of required steps", () => {
        const report = compareTrajectories([], [step(0, "tools/call", "issue_refund", { validated: false })], {
            mode: "policy",
            policy: {
                policyVersion: 1,
                prohibited: [{ method: "tools/call", toolName: "issue_refund", argsMatch: { validated: false } }],
            },
        });

        expect(report.summary.passed).toBe(false);
        expect(report.summary.prohibitedPresent).toBe(1);
    });

    it("optional steps never affect pass/fail either way", () => {
        const report = compareTrajectories([], [], {
            mode: "policy",
            policy: { policyVersion: 1, optional: [{ method: "tools/call", toolName: "verify_identity" }] },
        });

        expect(report.summary.passed).toBe(true);
        expect(report.steps[0]).toMatchObject({ outcome: "optional-absent" });
    });

    it("closedWorld:true treats an untracked actual step as prohibited", () => {
        const actual = [step(0, "tools/call", "lookup_customer"), step(1, "tools/call", "unexpected_tool")];
        const policy = { policyVersion: 1 as const, required: [{ method: "tools/call", toolName: "lookup_customer" }], closedWorld: true };

        const report = compareTrajectories([], actual, { mode: "policy", policy });
        expect(report.summary.passed).toBe(false);
        expect(report.summary.prohibitedPresent).toBe(1);
    });

    it("closedWorld:false (default) ignores an untracked actual step", () => {
        const actual = [step(0, "tools/call", "lookup_customer"), step(1, "tools/call", "unexpected_tool")];
        const policy = { policyVersion: 1 as const, required: [{ method: "tools/call", toolName: "lookup_customer" }] };

        const report = compareTrajectories([], actual, { mode: "policy", policy });
        expect(report.summary.passed).toBe(true);
    });

    it("throws when mode is policy but no policy document was provided", () => {
        expect(() => compareTrajectories([], [], { mode: "policy" })).toThrow(/policy document/);
    });
});
