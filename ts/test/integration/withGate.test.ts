import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { CassetteReader, CassetteWriter } from "../../src/core/cassette.js";
import { withGate } from "../../src/integration/vitest.js";
import { CassetteLine } from "../../src/core/types.js";

const testDir = resolve(process.cwd(), ".tmp-with-gate-test");

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

async function callToolsList(url: string): Promise<void> {
    await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
}

describe("withGate", () => {
    beforeAll(async () => {
        if (!existsSync(testDir)) await mkdir(testDir);
    });

    afterAll(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    it("passes when the agent's trajectory matches the golden", async () => {
        const golden = await writeGolden("happy.jsonl");
        await withGate(golden, async ({ url }) => {
            await callToolsList(url);
        })();
    });

    it("fails with a rendered report when the agent's behavior diverges", async () => {
        const golden = await writeGolden("divergent.jsonl");
        const run = withGate(golden, async ({ url }) => {
            await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "unexpected" } }),
            });
        });

        await expect(run()).rejects.toThrow(/FAIL/);
    });

    it("--update promotes the captured session when there were no replay misses", async () => {
        const golden = await writeGolden("update.jsonl");
        await withGate(
            golden,
            async ({ url }) => {
                await callToolsList(url);
            },
            { update: true }
        )();

        const { frames } = await new CassetteReader(golden).loadAll();
        expect(frames.find((f) => f.dir === "c2s")?.msg.method).toBe("tools/list");
    });

    it("refuses to promote (and still fails) when the session had a replay miss", async () => {
        const golden = await writeGolden("update-divergent.jsonl");
        const run = withGate(
            golden,
            async ({ url }) => {
                await fetch(url, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "unexpected" } }),
                });
            },
            { update: true }
        );

        await expect(run()).rejects.toThrow(/FAIL/);

        // The golden on disk is untouched.
        const { frames } = await new CassetteReader(golden).loadAll();
        expect(frames.find((f) => f.dir === "s2c")?.msg.result).toEqual({ tools: [] });
    });
});
