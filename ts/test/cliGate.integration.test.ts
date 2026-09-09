import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { CassetteWriter } from "../src/core/cassette.js";
import { CassetteLine } from "../src/core/types.js";
import { writeScriptFile } from "./helpers/fakeServer.js";
import { waitForExit } from "./helpers/process.js";

// Exercises the actual built CLI (dist/cli.js gate), not the runGate() library function
// directly -- the --json harness-failure wrapping this covers lives in cli.ts, one layer above
// runGate(). Requires `npm run build` to have run first.

const testDir = resolve(process.cwd(), ".tmp-cli-gate-test");
const cliPath = resolve(process.cwd(), "dist/cli.js");

async function writeGolden(): Promise<string> {
    const path = resolve(testDir, "golden.jsonl");
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

function collectStdout(child: ReturnType<typeof spawn>): { text(): string } {
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk.toString()));
    return { text: () => text };
}

describe("deja gate --json (built CLI)", () => {
    let goldenPath: string;
    let failingAgent: string[];

    beforeAll(async () => {
        if (!existsSync(testDir)) await mkdir(testDir);
        expect(existsSync(cliPath)).toBe(true);
        goldenPath = await writeGolden();
        failingAgent = await writeScriptFile(testDir, "agent-failing.cjs", "process.exit(7);");
    });

    afterAll(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    it("emits a structured {verdict:\"error\"} object on a harness failure instead of silently dropping --json", async () => {
        const child = spawn(process.execPath, [cliPath, "gate", goldenPath, "--json", "--", ...failingAgent]);
        const stdout = collectStdout(child);
        const exitCode = await waitForExit(child);

        expect(exitCode).toBe(3);
        const parsed = JSON.parse(stdout.text());
        expect(parsed).toEqual({ verdict: "error", reason: expect.stringContaining("exited with code 7"), exitCode: 3 });
    });
});
