import { IncomingMessage } from "node:http";

/** Generous for any real JSON-RPC/MCP payload; exists to bound worst-case memory growth from a
 *  pathological or malicious body instead of buffering it forever. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Buffers a request/response body in full. JSON-RPC payloads are small enough that streaming
 *  parsing isn't worth the complexity it would add to every caller. Rejects (and stops reading)
 *  once `MAX_BODY_BYTES` is exceeded, rather than buffering an unbounded body. */
export function readRawBody(stream: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let rejected = false;
        stream.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                // Reject (bounding memory -- stop accumulating chunks) but don't destroy the
                // socket: the caller still needs it intact to write a 413 response back.
                if (!rejected) {
                    rejected = true;
                    reject(new Error(`Deja: request body exceeds the ${MAX_BODY_BYTES}-byte limit`));
                }
                return;
            }
            chunks.push(chunk);
        });
        stream.on("end", () => resolve(Buffer.concat(chunks)));
        stream.on("error", reject);
    });
}