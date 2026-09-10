import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { CassetteReader, CassetteWriter } from "../../src/core/cassette.js";
import { runGate } from "../../src/gate/run.js";
import { CassetteLine } from "../../src/core/types.js";
import { writeScriptFile } from "../helpers/fakeServer.js";

const testDir = resolve(process.cwd(), ".tmp-gate-test");

async function writeGolden(name: string): Promise<string> {
    const path = resolve(testDir, name);
    const lines: CassetteLine[] = [
        { type: "header", version: 1, recorded_at: "now", transport: "http" },
        { type: "frame", dir: "c2s", t_ms: 0, msg: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
        { type: "frame", dir: "s2c", t_ms: 1, msg: { jsonrpc: "2.0", id: 1, result: { tools: [] } } },
    ];
    const writer = new CassetteWriter(path);
    for (const line of lines) writer.write(line);
    await writer.close();
    return path;
}

const AGENT_HAPPY = [
    "const url = process.env.DEJA_MCP_URL;",
    "fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })",
    "  .then(() => process.exit(0))",
    "  .catch(() => process.exit(1));",
].join("\n");

const AGENT_DIVERGENT = [
    "const url = process.env.DEJA_MCP_URL;",
    "fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'unexpected' } }) })",
    "  .then(() => process.exit(0))",
    "  .catch(() => process.exit(1));",
].join("\n");

const AGENT_FAILING = "process.exit(7);";

const AGENT_HANGING = "setTimeout(() => process.exit(0), 5000);";

describe("runGate", () => {
    let happyAgent: string[];
    let divergentAgent: string[];
    let failingAgent: string[];
    let hangingAgent: string[];

    beforeAll(async () => {
        if (!existsSync(testDir)) await mkdir(testDir);
        happyAgent = await writeScriptFile(testDir, "agent-happy.cjs", AGENT_HAPPY);
        divergentAgent = await writeScriptFile(testDir, "agent-divergent.cjs", AGENT_DIVERGENT);
        failingAgent = await writeScriptFile(testDir, "agent-failing.cjs", AGENT_FAILING);
        hangingAgent = await writeScriptFile(testDir, "agent-hanging.cjs", AGENT_HANGING);
    });

    afterAll(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    it("passes when the agent's trajectory matches the golden", async () => {
        const golden = await writeGolden("happy.jsonl");
        const result = await runGate(golden, happyAgent);

        expect(result.exitCode).toBe(0);
        expect(result.report?.summary.passed).toBe(true);
        expect(result.reason).toBeUndefined();
    });

    it("fails (exit 1) with a comparison report when the agent's behavior diverges", async () => {
        const golden = await writeGolden("divergent.jsonl");
        const result = await runGate(golden, divergentAgent);

        expect(result.exitCode).toBe(1);
        expect(result.report?.summary.passed).toBe(false);
        expect(result.report?.session?.replayMisses).toBe(1);
    });

    it("reports a harness failure (exit 3) when the agent exits non-zero", async () => {
        const golden = await writeGolden("failing.jsonl");
        const result = await runGate(golden, failingAgent);

        expect(result.exitCode).toBe(3);
        expect(result.report).toBeUndefined();
        expect(result.reason).toContain("exited with code 7");
        expect(result.reasonCode).toBe("agent-exit-nonzero");
    });

    it("times out, kills the agent, and reports a harness failure (exit 3)", async () => {
        const golden = await writeGolden("hanging.jsonl");
        const start = Date.now();
        const result = await runGate(golden, hangingAgent, { timeoutMs: 200 });

        expect(result.exitCode).toBe(3);
        expect(result.reason).toContain("timed out");
        expect(result.reasonCode).toBe("timeout");
        // Proves the agent was actually killed rather than this test just waiting the full 5s.
        expect(Date.now() - start).toBeLessThan(4000);
    }, 10000);

    it("--update promotes the captured session when there were no replay misses", async () => {
        const golden = await writeGolden("update-happy.jsonl");
        const result = await runGate(golden, happyAgent, { update: true });

        expect(result.exitCode).toBe(0);
        expect(result.updated).toBe(true);

        const { frames } = await new CassetteReader(golden).loadAll();
        expect(frames.find((f) => f.dir === "c2s")?.msg.method).toBe("tools/list");
    });

    it("--update refuses to promote when the agent diverged with a replay miss", async () => {
        const golden = await writeGolden("update-divergent.jsonl");
        const result = await runGate(golden, divergentAgent, { update: true });

        expect(result.exitCode).toBe(1);
        expect(result.updated).toBe(false);

        // The golden on disk is untouched.
        const { frames } = await new CassetteReader(golden).loadAll();
        expect(frames.find((f) => f.dir === "s2c")?.msg.result).toEqual({ tools: [] });
    });

    // Windows' chmod doesn't reliably block a write the way POSIX permissions do (the file's
    // owning process can often still overwrite a "read-only"-attributed file) -- this is a real
    // test on Linux/macOS, including the Linux CI runner this repo actually gates on, but not
    // reproducible on this dev machine.
    it.skipIf(process.platform === "win32")(
        "--update fails cleanly (not an unhandled rejection) when the golden file can't be written",
        async () => {
            const golden = await writeGolden("update-write-failure.jsonl");
            await chmod(golden, 0o444); // read-only, so promoteCapture's rewrite fails
            try {
                const result = await runGate(golden, happyAgent, { update: true });
                expect(result.exitCode).toBe(3);
                expect(result.reasonCode).toBe("update-write-failed");
                expect(result.reason).toContain("Failed to update golden cassette");
            } finally {
                await chmod(golden, 0o644); // restore so afterAll's rm() can clean up testDir
            }
        }
    );
});
