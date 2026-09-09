import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { CassetteReader } from "../../core/cassette.js";
import { readRawBody } from "./body.js";
import { normalizeIncoming, ReplayEngine, resolveBatch } from "../../core/replayEngine.js";
import { openCapture } from "../../gate/capture.js";
import { formatSseEvent } from "./sse.js";
import { ReplayOptions } from "../../core/types.js";

const JSON_CONTENT_TYPE = "application/json";
const SSE_CONTENT_TYPE = "text/event-stream";
const SESSION_HEADER = "mcp-session-id";

export interface HttpReplayHandle {
    port: number;
    close(): Promise<void>;
}

/** Tracks which session ids are currently live, so a request bearing a stale or unknown one
 *  is rejected the way a real MCP server would reject it. */
class SessionRegistry {
    private readonly active = new Set<string>();

    issue(): string {
        const id = randomUUID();
        this.active.add(id);
        return id;
    }

    isValid(id: string): boolean {
        return this.active.has(id);
    }

    end(id: string): boolean {
        return this.active.delete(id);
    }
}

function wantsEventStream(acceptHeader: string | undefined): boolean {
    return !!acceptHeader && acceptHeader.includes(SSE_CONTENT_TYPE) && !acceptHeader.includes(JSON_CONTENT_TYPE);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": JSON_CONTENT_TYPE, "content-length": Buffer.byteLength(payload) });
    res.end(payload);
}

/**
 * Serves a recorded cassette as a spec-compliant MCP Streamable HTTP server: a single POST
 * endpoint, session-id issuance/validation, 202 Accepted for notification-only bodies, 405
 * for GET (deja doesn't offer a standalone server-push stream), and JSON-RPC batch arrays.
 *
 * Session-id note: the cassette format doesn't currently capture the headers a session was
 * originally recorded with, so replay mints and manages its own session ids rather than
 * replaying the recorded ones -- this satisfies the transport *contract* (issue on
 * initialize, reject unknown/expired ids) independent of what happened during recording.
 */
export async function startHttpReplayServer(cassettePath: string, options: ReplayOptions = {}):
    Promise<HttpReplayHandle> {
    const { frames } = await new CassetteReader(cassettePath).loadAll();
    const engine = new ReplayEngine({ frames, semantic: options.semantic });
    const sessions = new SessionRegistry();
    const capture = options.capture ? openCapture(options.capture, "http") : undefined;

    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (req.method === "GET") {
            res.writeHead(405, { allow: "POST, DELETE" }).end();
            return;
        }

        if (req.method === "DELETE") {
            const sessionId = req.headers[SESSION_HEADER];
            if (typeof sessionId === "string") sessions.end(sessionId);
            res.writeHead(204).end();
            return;
        }

        if (req.method !== "POST") {
            res.writeHead(405, { allow: "POST, DELETE" }).end();
            return;
        }

        const contentType = req.headers["content-type"] ?? "";
        if (!contentType.includes(JSON_CONTENT_TYPE)) {
            sendJson(res, 415, { jsonrpc: "2.0", error: { code: -32700, message: "Deja: expected application/jsonbody" } });
                    return;
                }

                // Sessions are only enforced once a client presents one -- a stateless test client
                // that never sends the header is still free to talk to the replay server.
                const existingSession = req.headers[SESSION_HEADER];
                if (typeof existingSession === "string" && !sessions.isValid(existingSession)) {
                sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Deja: unknown or expired session" }
                });
                return;
            }

            let parsed: unknown;
            try {
                parsed = JSON.parse((await readRawBody(req)).toString("utf8"));
            } catch {
                sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Deja: invalid JSON body" } });
                return;
            }

            const incoming = normalizeIncoming(parsed);
            if (capture) for (const msg of incoming) capture.record("c2s", msg);

            const responses = await resolveBatch(engine, incoming);
            if (capture) for (const msg of responses) capture.record("s2c", msg);

            const isInitialize = incoming.some((msg) => msg.method === "initialize");
            const sessionId = isInitialize ? sessions.issue() : (existingSession as string | undefined);
            if (sessionId) res.setHeader(SESSION_HEADER, sessionId);

            if (responses.length === 0) {
                // Every message in the body was a notification -- nothing to reply with.
                res.writeHead(202).end();
                return;
            }

            if (wantsEventStream(req.headers.accept)) {
                res.writeHead(200, { "content-type": SSE_CONTENT_TYPE });
                for (const message of responses) res.write(formatSseEvent(message));
                res.end();
                return;
            }

            const body = incoming.length > 1 || Array.isArray(parsed) ? responses : responses[0];
            sendJson(res, 200, body);
        }

            const server = createServer((req, res) => {
                handleRequest(req, res).catch((err: Error) => {
                    sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: `Deja: internal replay error:
  ${err.message}` } });
                });
            });

            return new Promise((resolve, reject) => {
                server.on("error", reject);
                server.listen(options.port ?? 0, () => {
                    const address = server.address();
                    const port = typeof address === "object" && address ? address.port : options.port ?? 0;
                    resolve({
                        port,
                        close: async () => {
                            await new Promise<void>((r) => server.close(() => r()));
                            await capture?.close();
                        },
                    });
                });
            });
        }