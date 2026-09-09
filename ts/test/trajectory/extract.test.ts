import { describe, it, expect } from "vitest";
import { extractTrajectory } from "../../src/trajectory/extract.js";
import { CassetteFrame } from "../../src/core/types.js";

function frame(dir: "c2s" | "s2c", tMs: number, msg: CassetteFrame["msg"]): CassetteFrame {
    return { type: "frame", dir, t_ms: tMs, msg };
}

describe("extractTrajectory", () => {
    it("excludes initialize, server traffic, and notifications by default", () => {
        const frames: CassetteFrame[] = [
            frame("c2s", 0, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
            frame("s2c", 1, { jsonrpc: "2.0", id: 1, result: {} }),
            frame("c2s", 2, { jsonrpc: "2.0", method: "notifications/initialized" }), // no id
            frame("c2s", 3, { jsonrpc: "2.0", id: 2, method: "tools/list" }),
            frame("s2c", 4, { jsonrpc: "2.0", id: 2, result: { tools: [] } }),
        ];

        const steps = extractTrajectory(frames);
        expect(steps).toHaveLength(1);
        expect(steps[0]).toMatchObject({ index: 0, method: "tools/list", frameIndex: 3, tMs: 3 });
    });

    it("includes initialize when named via --include", () => {
        const frames: CassetteFrame[] = [frame("c2s", 0, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })];
        const steps = extractTrajectory(frames, { include: ["initialize"] });
        expect(steps).toHaveLength(1);
        expect(steps[0].method).toBe("initialize");
    });

    it("includes repeated calls to the same tool without deduplication", () => {
        const call = (id: number): CassetteFrame =>
            frame("c2s", id, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "search", query: "x" } });
        const frames = [call(1), call(2), call(3)];

        const steps = extractTrajectory(frames);
        expect(steps).toHaveLength(3);
        expect(steps.map((s) => s.toolName)).toEqual(["search", "search", "search"]);
    });

    it("extracts toolName only for tools/call, and strips _meta/id via normalization", () => {
        const frames: CassetteFrame[] = [
            frame("c2s", 0, {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "fetch", url: "https://a.test", _meta: { progressToken: "x" } },
            }),
        ];
        const steps = extractTrajectory(frames);
        expect(steps[0].toolName).toBe("fetch");
        expect(steps[0].params).toEqual({ name: "fetch", url: "https://a.test" });
        expect((steps[0].params as any)._meta).toBeUndefined();
    });

    it("assigns sequential index independent of frameIndex gaps", () => {
        const frames: CassetteFrame[] = [
            frame("c2s", 0, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
            frame("s2c", 1, { jsonrpc: "2.0", id: 1, result: {} }),
            frame("c2s", 2, { jsonrpc: "2.0", id: 2, method: "tools/list" }),
        ];
        const steps = extractTrajectory(frames);
        expect(steps.map((s) => s.index)).toEqual([0, 1]);
        expect(steps.map((s) => s.frameIndex)).toEqual([0, 2]);
    });
});
