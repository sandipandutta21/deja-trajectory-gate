import { describe, it, expect } from "vitest";
import { renderHumanReport, toCanonicalJson, toCanonicalReport } from "../../src/trajectory/report.js";
import { TrajectoryReport } from "../../src/trajectory/types.js";

const baseReport: TrajectoryReport = {
    reportVersion: 1,
    mode: "strict",
    threshold: 0.75,
    steps: [
        { goldenIndex: 0, actualIndex: 0, outcome: "exact", method: "tools/call", toolName: "search_orders" },
        { goldenIndex: 1, actualIndex: 1, outcome: "tolerated", method: "tools/call", toolName: "search_orders", score: 0.82, tier: "semantic" },
    ],
    summary: { passed: true, exact: 1, tolerated: 1, drifted: 0, added: 0, missing: 0, requiredMissing: 0, prohibitedPresent: 0 },
};

describe("toCanonicalReport", () => {
    it("omits undefined-valued fields", () => {
        const canonical = toCanonicalReport(baseReport);
        expect(canonical).not.toHaveProperty("session");
        expect((canonical.steps as any[])[0]).not.toHaveProperty("score");
        expect((canonical.steps as any[])[0]).not.toHaveProperty("tier");
    });

    it("serializes in a stable, explicit key order", () => {
        const json = toCanonicalJson(baseReport);
        const keys = Object.keys(JSON.parse(json));
        expect(keys).toEqual(["reportVersion", "mode", "threshold", "steps", "summary"]);
    });

    it("includes session only when present", () => {
        const withSession = { ...baseReport, session: { replayMisses: 1, firstMissFrameIndex: 4 } };
        const canonical = toCanonicalReport(withSession);
        expect(canonical.session).toEqual({ replayMisses: 1, firstMissFrameIndex: 4 });
    });
});

describe("renderHumanReport", () => {
    it("labels the first post-divergence step ROOT DIVERGENCE and later ones POST-DIVERGENCE", () => {
        const report: TrajectoryReport = {
            reportVersion: 1,
            mode: "superset",
            threshold: 0.75,
            steps: [
                { goldenIndex: 0, actualIndex: 0, outcome: "exact", method: "tools/list" },
                { actualIndex: 1, outcome: "added", method: "tools/call", toolName: "send_email", phase: "post-divergence" },
                { actualIndex: 2, outcome: "added", method: "tools/list", phase: "post-divergence" },
            ],
            session: { replayMisses: 1, firstMissFrameIndex: 1 },
            summary: { passed: false, exact: 1, tolerated: 0, drifted: 0, added: 2, missing: 0, requiredMissing: 0, prohibitedPresent: 0 },
        };

        const rendered = renderHumanReport(report, "golden/refund-flow.jsonl");
        expect(rendered).toContain("ROOT DIVERGENCE");
        expect(rendered).toContain("POST-DIVERGENCE");
        expect(rendered).toContain("root divergences: 1");
        expect(rendered).toContain("post-divergence observations: 1");
        expect(rendered).toContain("FAIL -- behavior diverged (mode=superset)");
    });

    it("prints PASS when the summary passed", () => {
        expect(renderHumanReport(baseReport)).toContain("PASS (mode=strict)");
    });
});
