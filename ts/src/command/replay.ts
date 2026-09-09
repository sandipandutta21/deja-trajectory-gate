import { createInterface } from "node:readline";
import { CassetteReader } from "../core/cassette.js";
import { startHttpReplayServer } from "../transport/http/server.js";
import { ReplayEngine } from "../core/replayEngine.js";
import { openCapture } from "../gate/capture.js";
import { JsonRpcMessage, ReplayOptions } from "../core/types.js";

/**
 * Replays a cassette over stdio: one JSON-RPC message (or batch array) per line in, one
 * response per line out. Lines are processed through a promise queue rather than fired
 * independently, so responses come back in request order even though matching (semantic
 * tier, an optional judge) is asynchronous -- output order stays deterministic and easy to
 * read even though JSON-RPC itself doesn't require it.
 */
export async function replayStdio(cassettePath: string, options: ReplayOptions = {}): Promise<void> {
    const { frames } = await new CassetteReader(cassettePath).loadAll();
    const engine = new ReplayEngine({ frames, semantic: options.semantic, consumeOnce: options.consumeOnce });
    const rl = createInterface({ input: process.stdin });
    const capture = options.capture ? openCapture(options.capture, "stdio") : undefined;

    let queue: Promise<void> = Promise.resolve();

    const handleLine = async (line: string): Promise<void> => {
        let incoming: JsonRpcMessage;
        try {
            incoming = JSON.parse(line) as JsonRpcMessage;
        } catch {
            return; // not JSON-RPC -- nothing for deja to answer
        }

        capture?.record("c2s", incoming);
        const response = await engine.resolve(incoming);
        if (response) {
            capture?.record("s2c", response);
            process.stdout.write(JSON.stringify(response) + "\n");
        }
    };

    rl.on("line", (line) => {
        if (!line.trim()) return;
        queue = queue.then(() => handleLine(line));
    });

    await new Promise<void>((resolve) => rl.on("close", resolve));
    await queue;
    await capture?.close();
}

/** Serves a cassette as a spec-compliant MCP Streamable HTTP server until interrupted. */
export async function replayHttp(cassettePath: string, options: ReplayOptions = {}): Promise<void> {
    const handle = await startHttpReplayServer(cassettePath, options);
    console.error(`Deja: replay server listening on http://localhost:${handle.port}`);

    await new Promise<void>((resolve) => {
        const shutdown = async (): Promise<void> => {
            process.off("SIGINT", shutdown);
            process.off("SIGTERM", shutdown);
            await handle.close();
            resolve();
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    });
}