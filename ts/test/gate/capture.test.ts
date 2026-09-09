import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { CassetteReader, CassetteWriter } from "../../src/core/cassette.js";
import { startHttpReplayServer, HttpReplayHandle } from "../../src/transport/http/server.js";
import { detectReplaySession } from "../../src/trajectory/frontier.js";
import { CassetteLine } from "../../src/core/types.js";

const testDir = resolve(process.cwd(), ".tmp-capture-test");

async function post(port: number, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

describe("HTTP replay capture tee", () => {
    beforeAll(async () => {
        if (!existsSync(testDir)) await mkdir(testDir);
    });

    afterAll(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    it("tees every inbound/outbound frame, redacted, with fresh capture-local timestamps", async () => {
        const goldenPath = resolve(testDir, "golden.jsonl");
        const lines: CassetteLine[] = [
            { type: "header", version: 1, recorded_at: "now", transport: "http" },
            { type: "frame", dir: "c2s", t_ms: 999999, msg: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
            { type: "frame", dir: "s2c", t_ms: 999999, msg: { jsonrpc: "2.0", id: 1, result: { tools: [] } } },
        ];
        const writer = new CassetteWriter(goldenPath);
        for (const line of lines) writer.write(line);
        await writer.close();

        const capturePath = resolve(testDir, "actual.jsonl");
        let handle: HttpReplayHandle | undefined;
        try {
            handle = await startHttpReplayServer(goldenPath, { capture: capturePath });

            // A matched request.
            await post(handle.port, { jsonrpc: "2.0", id: 1, method: "tools/list" });

            // An unrecorded request, carrying a secret -- the capture must redact it even
            // though the request itself is a miss (the -32603 sentinel for it).
            await post(handle.port, {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "unrecorded", note: "sk-abc123def456ghi789jkl012mno345pqr678stu901" },
            });
        } finally {
            await handle?.close();
        }

        const { header, frames } = await new CassetteReader(capturePath).loadAll();
        expect(header.transport).toBe("http");

        const c2s = frames.filter((f) => f.dir === "c2s");
        expect(c2s).toHaveLength(2);
        expect((c2s[1].msg.params as any).note).toMatch(/^\[REDACTED:sk:[a-f0-9]{8}]$/);

        // Capture-local timestamps, not the golden's -- and non-decreasing across the session.
        expect(frames.every((f) => f.t_ms < 999999)).toBe(true);
        expect(frames[frames.length - 1].t_ms).toBeGreaterThanOrEqual(frames[0].t_ms);

        const session = detectReplaySession(frames);
        expect(session?.replayMisses).toBe(1);
    });
});
