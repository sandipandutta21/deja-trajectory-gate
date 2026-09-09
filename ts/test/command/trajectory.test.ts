import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { CassetteWriter } from "../../src/core/cassette.js";
import { compareTrajectoryCassettes, deriveTrajectoryPolicy, readTrajectoryPolicy } from "../../src/command/trajectory.js";
import { CassetteLine } from "../../src/core/types.js";

const testDir = resolve(process.cwd(), ".tmp-trajectory-test");

async function writeCassette(name: string, lines: CassetteLine[]): Promise<string> {
    const path = resolve(testDir, name);
    const writer = new CassetteWriter(path);
    for (const line of lines) writer.write(line);
    await writer.close();
    return path;
}

const header: CassetteLine = { type: "header", version: 1, recorded_at: "now", transport: "stdio" };

describe("compareTrajectoryCassettes", () => {
    beforeAll(async () => {
        if (!existsSync(testDir)) await mkdir(testDir);
    });

    afterAll(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    it("passes strict comparison for two structurally identical cassettes", async () => {
        const lines: CassetteLine[] = [
            header,
            { type: "frame", dir: "c2s", t_ms: 0, msg: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", q: "a" } } },
            { type: "frame", dir: "s2c", t_ms: 1, msg: { jsonrpc: "2.0", id: 1, result: { ok: true } } },
        ];
        const golden = await writeCassette("identical-golden.jsonl", lines);
        const actual = await writeCassette("identical-actual.jsonl", lines);

        const report = await compareTrajectoryCassettes(golden, actual);
        expect(report.summary.passed).toBe(true);
        expect(report.summary.exact).toBe(1);
    });

    it("fails when the actual cassette has an extra tool call", async () => {
        const golden = await writeCassette("extra-golden.jsonl", [
            header,
            { type: "frame", dir: "c2s", t_ms: 0, msg: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
        ]);
        const actual = await writeCassette("extra-actual.jsonl", [
            header,
            { type: "frame", dir: "c2s", t_ms: 0, msg: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
            { type: "frame", dir: "c2s", t_ms: 1, msg: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_email" } } },
        ]);

        const report = await compareTrajectoryCassettes(golden, actual);
        expect(report.summary.passed).toBe(false);
        expect(report.summary.added).toBe(1);
    });

    it("derives a policy from a golden cassette and can then gate with it", async () => {
        const golden = await writeCassette("derive-golden.jsonl", [
            header,
            { type: "frame", dir: "c2s", t_ms: 0, msg: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lookup_customer" } } },
        ]);
        const policyPath = resolve(testDir, "derived-policy.json");

        const policy = await deriveTrajectoryPolicy(golden, policyPath);
        expect(policy.required).toHaveLength(1);
        expect(policy.required?.[0]).toMatchObject({ method: "tools/call", toolName: "lookup_customer" });

        const onDisk = await readTrajectoryPolicy(policyPath);
        expect(onDisk).toEqual(policy);

        const actual = await writeCassette("derive-actual.jsonl", [
            header,
            { type: "frame", dir: "c2s", t_ms: 0, msg: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lookup_customer" } } },
        ]);

        const report = await compareTrajectoryCassettes(golden, actual, { mode: "policy", policy: onDisk });
        expect(report.summary.passed).toBe(true);
    });

    it("recovers divergence-frontier evidence embedded in a captured actual cassette", async () => {
        const golden = await writeCassette("frontier-golden.jsonl", [
            header,
            { type: "frame", dir: "c2s", t_ms: 0, msg: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
        ]);
        const actual = await writeCassette("frontier-actual.jsonl", [
            header,
            { type: "frame", dir: "c2s", t_ms: 0, msg: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
            { type: "frame", dir: "s2c", t_ms: 1, msg: { jsonrpc: "2.0", id: 1, result: {} } },
            { type: "frame", dir: "c2s", t_ms: 2, msg: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "unrecorded" } } },
            {
                type: "frame",
                dir: "s2c",
                t_ms: 3,
                msg: { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "Deja: No matching recorded request found in cassette" } },
            },
        ]);

        const report = await compareTrajectoryCassettes(golden, actual, { mode: "superset" });
        expect(report.session).toEqual({ replayMisses: 1, firstMissFrameIndex: 2 });
        expect(report.steps.find((s) => s.toolName === "unrecorded")?.phase).toBe("post-divergence");
    });
});
