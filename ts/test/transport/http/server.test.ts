import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { CassetteWriter } from "../../../src/core/cassette.js";
import { extractJsonRpcFromSse } from "../../../src/transport/http/sse.js";
import { startHttpReplayServer, HttpReplayHandle } from "../../../src/transport/http/server.js";
import { MAX_BODY_BYTES } from "../../../src/transport/http/body.js";
import { CassetteLine } from "../../../src/core/types.js";

const testDir = resolve(process.cwd(), ".tmp-http-server-test");

async function writeFixtureCassette(path: string): Promise<void> {
  const lines: CassetteLine[] = [
    { type: "header", version: 1, recorded_at: "now", transport: "http" },
    { type: "frame", dir: "c2s", t_ms: 0, msg: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1.0" } } },
    { type: "frame", dir: "s2c", t_ms: 1, msg: { jsonrpc: "2.0", id: 1, result: { capabilities: {} } } },
    {
      type: "frame",
      dir: "c2s",
      t_ms: 2,
      msg: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fetch", url: "https://example.com/page" } },
    },
    { type: "frame", dir: "s2c", t_ms: 3, msg: { jsonrpc: "2.0", id: 2, result: { ok: true } } },
    // A non-path field for the semantic-tier test: url/path params are hard-gated to exact
    // match (see match.test.ts's hard safety gate tests), so a near-miss fuzzy match needs a
    // prose-like field instead.
    {
      type: "frame",
      dir: "c2s",
      t_ms: 4,
      msg: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", query: "best pizza near me" } },
    },
    { type: "frame", dir: "s2c", t_ms: 5, msg: { jsonrpc: "2.0", id: 3, result: { ok: true } } },
  ];

  const writer = new CassetteWriter(path);
  for (const line of lines) writer.write(line);
  await writer.close();
}

async function post(port: number, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("startHttpReplayServer", () => {
  let handle: HttpReplayHandle;
  let semanticHandle: HttpReplayHandle;

  beforeAll(async () => {
    if (!existsSync(testDir)) await mkdir(testDir);

    const cassettePath = resolve(testDir, "fixture.jsonl");
    await writeFixtureCassette(cassettePath);
    handle = await startHttpReplayServer(cassettePath);

    const semanticCassettePath = resolve(testDir, "fixture-semantic.jsonl");
    await writeFixtureCassette(semanticCassettePath);
    semanticHandle = await startHttpReplayServer(semanticCassettePath, { semantic: true });
  });

  afterAll(async () => {
    await handle.close();
    await semanticHandle.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it("resolves a structurally-matching request and rewrites the response id", async () => {
    const res = await post(handle.port, { jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "fetch", url: "https://example.com/page" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ jsonrpc: "2.0", id: 42, result: { ok: true } });
  });

  it("issues an Mcp-Session-Id header on initialize", async () => {
    const res = await post(handle.port, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("rejects a request bearing an unknown session id with 404", async () => {
    const res = await post(handle.port, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fetch", url: "https://example.com/page" } }, { "mcp-session-id": "not-a-real-session" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe(-32001);
  });

  it("accepts a request bearing a session id it issued", async () => {
    const initRes = await post(handle.port, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const sessionId = initRes.headers.get("mcp-session-id")!;

    const res = await post(
      handle.port,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fetch", url: "https://example.com/page" } },
      { "mcp-session-id": sessionId }
    );
    expect(res.status).toBe(200);
  });

  it("responds 202 with an empty body when every message is a notification", async () => {
    const res = await post(handle.port, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("resolves a JSON-RPC batch, dropping notifications from the response array", async () => {
    const res = await post(handle.port, [
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fetch", url: "https://example.com/page" } },
      { jsonrpc: "2.0", method: "notifications/progress" },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(2);
  });

  it("responds 405 to GET (no standalone server-push stream)", async () => {
    const res = await fetch(`http://localhost:${handle.port}/mcp`, { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
  });

  it("responds 415 for a non-JSON content-type", async () => {
    const res = await post(handle.port, "not json", { "content-type": "text/plain" });
    expect(res.status).toBe(415);
  });

  it("responds 400 for malformed JSON", async () => {
    const res = await fetch(`http://localhost:${handle.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("responds 413 and stops reading, instead of buffering forever, for a body over the size limit", async () => {
    const oversized = "x".repeat(MAX_BODY_BYTES + 1);
    const res = await fetch(`http://localhost:${handle.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    });
    expect(res.status).toBe(413);
  });

  it("streams the response as SSE when the client only accepts text/event-stream", async () => {
    const res = await post(
      handle.port,
      { jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "fetch", url: "https://example.com/page" } },
      { accept: "text/event-stream" }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const messages = extractJsonRpcFromSse(await res.text());
    expect(messages).toHaveLength(1);
    expect(messages[0].result).toEqual({ ok: true });
  });

  it("204s a DELETE and invalidates that session for subsequent requests", async () => {
    const initRes = await post(handle.port, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const sessionId = initRes.headers.get("mcp-session-id")!;

    const deleteRes = await fetch(`http://localhost:${handle.port}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
    expect(deleteRes.status).toBe(204);

    const followUp = await post(
      handle.port,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fetch", url: "https://example.com/page" } },
      { "mcp-session-id": sessionId }
    );
    expect(followUp.status).toBe(404);
  });

  it("falls back to the semantic tier when enabled at construction", async () => {
    const res = await post(semanticHandle.port, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "search", query: "best pizza near mee" }, // one character off
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toEqual({ ok: true });
  });

  it("returns a -32603 no-match error for a request with no plausible recorded counterpart", async () => {
    const res = await post(handle.port, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "fetch", url: "https://nothing-like-this-was-ever-recorded.test" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.code).toBe(-32603);
  });
});
