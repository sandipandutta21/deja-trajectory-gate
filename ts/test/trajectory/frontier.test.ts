import { describe, it, expect } from "vitest";
import { buildNoMatchError } from "../../src/core/replayEngine.js";
import { CassetteFrame } from "../../src/core/types.js";
import { detectReplaySession } from "../../src/trajectory/frontier.js";
import { compareCassetteFrames } from "../../src/trajectory/compare.js";

function c2s(frameIndex: number, id: number, method: string): CassetteFrame {
    return { type: "frame", dir: "c2s", t_ms: frameIndex, msg: { jsonrpc: "2.0", id, method } };
}

function s2c(frameIndex: number, msg: CassetteFrame["msg"]): CassetteFrame {
    return { type: "frame", dir: "s2c", t_ms: frameIndex, msg };
}

describe("detectReplaySession", () => {
    it("returns undefined when the actual cassette carries no replay-miss evidence", () => {
        const frames = [c2s(0, 1, "tools/list"), s2c(1, { jsonrpc: "2.0", id: 1, result: { tools: [] } })];
        expect(detectReplaySession(frames)).toBeUndefined();
    });

    it("finds the first replay-miss sentinel and counts every one", () => {
        const frames = [
            c2s(0, 1, "tools/list"),
            s2c(1, { jsonrpc: "2.0", id: 1, result: { tools: [] } }),
            c2s(2, 2, "tools/call"),
            s2c(3, buildNoMatchError(2)),
            c2s(4, 3, "tools/list"),
            s2c(5, buildNoMatchError(3)),
        ];

        const session = detectReplaySession(frames);
        expect(session).toEqual({ replayMisses: 2, firstMissFrameIndex: 2 });
    });
});

describe("compareCassetteFrames -- divergence frontier tagging", () => {
    it("marks the unserved request and everything after it as post-divergence", () => {
        const goldenFrames = [c2s(0, 1, "tools/list")];
        const actualFrames = [
            c2s(0, 1, "tools/list"),
            s2c(1, { jsonrpc: "2.0", id: 1, result: { tools: [] } }),
            c2s(2, 2, "tools/call"), // unrecorded -- this is the frontier
            s2c(3, buildNoMatchError(2)),
            c2s(4, 3, "tools/list"), // post-divergence diagnostic noise
        ];

        const report = compareCassetteFrames(goldenFrames, actualFrames, { mode: "superset" });
        expect(report.session).toEqual({ replayMisses: 1, firstMissFrameIndex: 2 });

        const added = report.steps.filter((s) => s.outcome === "added");
        expect(added).toHaveLength(2);
        expect(added.every((s) => s.phase === "post-divergence")).toBe(true);

        const exactSteps = report.steps.filter((s) => s.outcome === "exact");
        expect(exactSteps.every((s) => s.phase === undefined)).toBe(true);
    });
});
