import {ChildProcessByStdio, ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, afterEach } from "vitest";
import { CassetteReader, CassetteWriter } from "../core/cassette.js";
import { redactObject } from "../core/redact.js";
import { promoteCapture } from "../gate/run.js";
import { ReplayEngine } from "../core/replayEngine.js";
import { startHttpReplayServer } from "../transport/http/server.js";
import { compareCassetteFrames } from "../trajectory/compare.js";
import { renderHumanReport } from "../trajectory/report.js";
import { TrajectoryCompareOptions } from "../trajectory/types.js";
import { JsonRpcMessage, ReplayOptions } from "../core/types.js";
import {Readable, Writable} from "node:stream";

export interface UseCassetteOptions {
    record?: {
        command: string[];
        noRedact?: boolean;
    };
    semantic?: ReplayOptions["semantic"];
}

type RequestHandler = (method: string, params?: unknown) => Promise<any>;

const NO_MATCH_MESSAGE_PREFIX = "Deja: No matching";

/** Spawns a real MCP server over stdio and records every call made through it -- the live
 *  counterpart to `ReplayEngine`, active only when `DEJA_MODE=record`. */
class RecordingSession {
    private readonly child: ChildProcessByStdio<Writable, Readable, null>;
    private readonly rlOut: ReturnType<typeof createInterface>;
    private readonly writer: CassetteWriter;
    private readonly noRedact: boolean;
    private readonly startTime = Date.now();
    private nextId = 1;

    constructor(command: string[], cassettePath: string, noRedact: boolean) {
        this.noRedact = noRedact;
        this.writer = new CassetteWriter(cassettePath);
        this.writer.write({
            type: "header",
            version: 1,
            recorded_at: new Date().toISOString(),
            transport: "stdio",
            server_command: command,
        });

        this.child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
        this.rlOut = createInterface({ input: this.child.stdout });
    }

    async send(method: string, params?: unknown): Promise<JsonRpcMessage> {
        const request: JsonRpcMessage = {
            jsonrpc: "2.0",
            id: this.nextId++,
            method,
            params: params as Record<string, unknown> | undefined,
        };

        const responsePromise = new Promise<JsonRpcMessage>((resolve, reject) => {
            this.rlOut.once("line", (line) => {
                try {
                    resolve(JSON.parse(line) as JsonRpcMessage);
                } catch (err) {
                    reject(err);
                }
            });
        });

        this.child.stdin.write(JSON.stringify(request) + "\n");
        const response = await responsePromise;

        this.record("c2s", request);
        this.record("s2c", response);

        return response;
    }

    private record(dir: "c2s" | "s2c", msg: JsonRpcMessage): void {
        this.writer.write({
            type: "frame",
            dir,
            t_ms: Date.now() - this.startTime,
            msg: this.noRedact ? msg : (redactObject(msg) as JsonRpcMessage),
        });
    }

    async close(): Promise<void> {
        this.rlOut.close();
        this.child.stdin.end();
        this.child.kill();
        await this.writer.close();
    }
}

/**
 * A vitest fixture for MCP tests. In replay mode (the default), every `request()`/`connect()`
 * call is answered from a cassette with zero subprocess and zero network access, so the suite
 * is fast and deterministic in CI. Setting `DEJA_MODE=record` re-records the identical test
 * code against a real server (`options.record.command`), refreshing the cassette without
 * touching a single assertion.
 */
export function useCassette(cassettePath: string, options: UseCassetteOptions) {
    const mode = process.env.DEJA_MODE === "record" ? "record" : "replay";
    let missedRequests: JsonRpcMessage[] = [];

    // Loading starts immediately but every call site `await`s it, so there's no window where
    // a request can race ahead of the cassette finishing to load (the original implementation
    // fired this load-and-forget and relied on callers happening to wait long enough).
    const enginePromise: Promise<ReplayEngine> | null =
        mode === "replay"
            ? new CassetteReader(cassettePath).loadAll().then(({ frames }) => new ReplayEngine({ frames, semantic:
                options.semantic }))
            : null;

    let recordingSession: RecordingSession | null = null;
    function getRecordingSession(): RecordingSession {
        if (!options.record) {
            throw new Error("Deja: DEJA_MODE=record requires useCassette's `record.command` option to be set.");
        }
        if (!recordingSession) {
            recordingSession = new RecordingSession(options.record.command, cassettePath, !!options.record.noRedact);
        }
        return recordingSession;
    }

    const requestHandler: RequestHandler = async (method, params) => {
        if (mode === "record") {
            const response = await getRecordingSession().send(method, params);
            if (response.error) throw response.error;
            return response.result;
        }

        const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: Date.now(), method, params: params as Record<string,
                unknown> | undefined };
        const engine = await enginePromise!;
        const response = await engine.resolve(incoming);

        // A synthesized "no recorded match" is a test-authoring problem, not a protocol error
        // the code under test should have to handle -- surface it as a thrown Error instead.
        if (response?.error?.code === -32603 && response.error.message.startsWith(NO_MATCH_MESSAGE_PREFIX)) {
            missedRequests.push(incoming);
            throw new Error(`Deja: No matching recorded request found for method '${method}'`);
        }

        if (response?.error) throw response.error;
        return response?.result;
    };

    afterEach(() => {
        if (missedRequests.length > 0) {
            const misses = [...missedRequests];
            missedRequests = [];
            throw new Error(
                `Deja Test Failed: ${misses.length} unmatched requests during offline replay.\n` +
                `Ensure your agent's requests match the cassette structurally, or enable the semantic tier.\n` +
                `Missed: ${JSON.stringify(misses, null, 2)}`
            );
        }
    });

    afterAll(async () => {
        if (recordingSession) await recordingSession.close();
    });

    return {
        request: requestHandler,
        connect: async () => {
            // Lazy-load the official SDK only if the test invokes .connect()
            const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
            const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

            const transport = new InMemoryTransport();
            const client = new Client({ name: "deja-test", version: "1.0.0" }, { capabilities: {} });

            // `InMemoryTransport` has no `handleMessage` method -- the way to deliver a
            // "received" message on this same transport within one process is its public
            // `onmessage` callback, which `client.connect()` wires up internally below.
            // Narrowing to `"id" in message` (not just `"method" in message`) excludes
            // notifications, which have no response to synthesize in the first place.
            transport.send = async (message) => {
                if ("method" in message && "id" in message) {
                    try {
                        const result = await requestHandler(message.method, message.params);
                        transport.onmessage?.({ jsonrpc: "2.0", id: message.id, result } as any);
                    } catch (error) {
                        transport.onmessage?.({ jsonrpc: "2.0", id: message.id, error } as any);
                    }
                }
            };

            await client.connect(transport);
            return client;
        },
    };
}

export interface GateContext {
    /** The replay server's URL -- point the agent under test's own MCP client at this. */
    url: string;
}

export interface WithGateOptions extends TrajectoryCompareOptions {
    /** Promote the captured session to become the new golden (safe-update preconditions still
     *  apply -- refused, and the test still fails, if there was any replay miss). */
    update?: boolean;
}

/**
 * A vitest fixture for Trajectory Gate assertions: starts an HTTP replay server
 * over `goldenPath` with a capture tee, hands the test callback the replay URL to point its own
 * agent/MCP client at, then -- once the callback returns -- extracts and compares the captured
 * trajectory against the golden, failing the test on divergence. The fixture owns the whole
 * replay lifecycle, capture, and assertion; the test body only drives the agent under test:
 *
 * ```ts
 * test("files a ticket for a refund request", withGate("golden/refund-flow.jsonl", async ({ url }) => {
 *   await runMyAgent({ mcpUrl: url, prompt: "customer wants a refund" });
 * }));
 * ```
 */
export function withGate(
    goldenPath: string,
    testFn: (ctx: GateContext) => Promise<void>,
    options: WithGateOptions = {}
): () => Promise<void> {
    return async () => {
        const capturePath = resolve(tmpdir(), `deja-gate-${randomUUID()}.jsonl`);
        const { header, frames: goldenFrames } = await new CassetteReader(goldenPath).loadAll();
        const handle = await startHttpReplayServer(goldenPath, { capture: capturePath });

        try {
            await testFn({ url: `http://127.0.0.1:${handle.port}` });
        } finally {
            await handle.close();
        }

        try {
            const { frames: actualFrames } = await new CassetteReader(capturePath).loadAll();
            const report = compareCassetteFrames(goldenFrames, actualFrames, options);

            // A recording/update mode must never silently promote an incomplete capture:
            // promotion requires zero replay misses, same precondition `deja gate --update`
            // enforces. Refused, the test still fails on the report below rather than passing
            // silently.
            if (options.update && (report.session?.replayMisses ?? 0) === 0) {
                await promoteCapture(goldenPath, header, capturePath);
                return;
            }

            if (!report.summary.passed) {
                throw new Error(renderHumanReport(report, goldenPath));
            }
        } finally {
            await unlink(capturePath).catch(() => {});
        }
    };
}