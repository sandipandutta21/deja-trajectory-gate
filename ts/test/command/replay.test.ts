import { describe, it, expect } from "vitest";
import { buildNoMatchError, normalizeIncoming, pairInteractions, ReplayEngine, resolveBatch } from "../../src/core/replayEngine.js";
import { CassetteFrame, JsonRpcMessage } from "../../src/core/types.js";

function frame(dir: "c2s" | "s2c", msg: JsonRpcMessage, t_ms = 0): CassetteFrame {
  return { type: "frame", dir, t_ms, msg };
}

describe("pairInteractions", () => {
  it("pairs a c2s request with its matching s2c response by id", () => {
    const frames = [
      frame("c2s", { jsonrpc: "2.0", id: 1, method: "tools/list" }),
      frame("s2c", { jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    ];

    const pairs = pairInteractions(frames);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].request.msg.method).toBe("tools/list");
  });

  it("drops requests that never received a recorded response", () => {
    const frames = [frame("c2s", { jsonrpc: "2.0", id: 1, method: "tools/list" })];
    expect(pairInteractions(frames)).toHaveLength(0);
  });

  it("ignores notifications (no id) on both sides", () => {
    const frames = [
      frame("c2s", { jsonrpc: "2.0", method: "notifications/initialized" }),
      frame("s2c", { jsonrpc: "2.0", method: "notifications/progress" }),
    ];
    expect(pairInteractions(frames)).toHaveLength(0);
  });

  it("pairs multiple interleaved requests correctly by id, not by order", () => {
    const frames = [
      frame("c2s", { jsonrpc: "2.0", id: 1, method: "a" }),
      frame("c2s", { jsonrpc: "2.0", id: 2, method: "b" }),
      frame("s2c", { jsonrpc: "2.0", id: 2, result: "b-result" }),
      frame("s2c", { jsonrpc: "2.0", id: 1, result: "a-result" }),
    ];

    const pairs = pairInteractions(frames);
    expect(pairs).toHaveLength(2);
    const byMethod = Object.fromEntries(pairs.map((p) => [p.request.msg.method, p.response.msg.result]));
    expect(byMethod.a).toBe("a-result");
    expect(byMethod.b).toBe("b-result");
  });
});

describe("buildNoMatchError", () => {
  it("uses -32603 (Internal error), not -32601", () => {
    const err = buildNoMatchError(5);
    expect(err.error?.code).toBe(-32603);
    expect(err.id).toBe(5);
  });
});

describe("ReplayEngine", () => {
  const frames = [
    frame("c2s", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fetch", url: "https://example.com/page" } }),
    frame("s2c", { jsonrpc: "2.0", id: 1, result: { ok: true } }),
  ];

  it("resolves a structural match and rewrites the response id", async () => {
    const engine = new ReplayEngine({ frames });
    const res = await engine.resolve({ jsonrpc: "2.0", id: 999, method: "tools/call", params: { name: "fetch", url: "https://example.com/page" } });
    expect(res?.id).toBe(999);
    expect(res?.result).toEqual({ ok: true });
  });

  it("returns null for a notification, matched or not", async () => {
    const engine = new ReplayEngine({ frames });
    const res = await engine.resolve({ jsonrpc: "2.0", method: "tools/call", params: { name: "fetch", url: "https://example.com/page" } });
    expect(res).toBeNull();
  });

  it("returns a -32603 error for an unmatched request when semantic is off", async () => {
    const engine = new ReplayEngine({ frames });
    const res = await engine.resolve({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fetch", url: "https://totally-different.test" } });
    expect(res?.error?.code).toBe(-32603);
  });

  it("falls back to the semantic tier when enabled", async () => {
    // Uses a prose-like "query" field rather than a path/URL: those are hard-gated to exact
    // match (see match.test.ts's hard safety gate tests), so this needs a field where
    // near-equality is a meaningful fuzzy-match signal.
    const queryFrames = [
      frame("c2s", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", query: "best pizza near me" } }),
      frame("s2c", { jsonrpc: "2.0", id: 1, result: { ok: true } }),
    ];
    const engine = new ReplayEngine({ frames: queryFrames, semantic: true });
    const res = await engine.resolve({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", query: "best pizza near mee" } });
    expect(res?.result).toEqual({ ok: true });
  });

  it("does not fall back to semantic when disabled, even for a close match", async () => {
    const engine = new ReplayEngine({ frames, semantic: false });
    const res = await engine.resolve({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fetch", url: "https://example.com/pagee" } });
    expect(res?.error?.code).toBe(-32603);
  });

  it("recordedInteractionCount reflects the number of paired interactions", () => {
    const engine = new ReplayEngine({ frames });
    expect(engine.recordedInteractionCount).toBe(1);
  });

  describe("consumeOnce", () => {
    it("resolves an identical request every time by default (stateless)", async () => {
      const engine = new ReplayEngine({ frames });
      const request = { jsonrpc: "2.0" as const, id: 1, method: "tools/call", params: { name: "fetch", url: "https://example.com/page" } };
      expect((await engine.resolve(request))?.result).toEqual({ ok: true });
      expect((await engine.resolve({ ...request, id: 2 }))?.result).toEqual({ ok: true });
    });

    it("with consumeOnce, a second identical request misses once the one recorded interaction is used", async () => {
      const engine = new ReplayEngine({ frames, consumeOnce: true });
      const request = { jsonrpc: "2.0" as const, id: 1, method: "tools/call", params: { name: "fetch", url: "https://example.com/page" } };
      expect((await engine.resolve(request))?.result).toEqual({ ok: true });
      const second = await engine.resolve({ ...request, id: 2 });
      expect(second?.error?.code).toBe(-32603);
    });

    it("with consumeOnce and two recorded identical interactions, resolves in recorded order then misses", async () => {
      const call = (id: number) => ({ jsonrpc: "2.0" as const, id, method: "tools/call", params: { name: "fetch", url: "https://example.com/page" } });
      const twoInteractionFrames = [
        frame("c2s", call(1)),
        frame("s2c", { jsonrpc: "2.0", id: 1, result: { page: "first" } }),
        frame("c2s", call(2)),
        frame("s2c", { jsonrpc: "2.0", id: 2, result: { page: "second" } }),
      ];
      const engine = new ReplayEngine({ frames: twoInteractionFrames, consumeOnce: true });
      const request = call(10);

      expect((await engine.resolve({ ...request, id: 10 }))?.result).toEqual({ page: "first" });
      expect((await engine.resolve({ ...request, id: 11 }))?.result).toEqual({ page: "second" });
      expect((await engine.resolve({ ...request, id: 12 }))?.error?.code).toBe(-32603);
    });
  });
});

describe("normalizeIncoming / resolveBatch", () => {
  it("normalizeIncoming wraps a single message in a one-element array", () => {
    const msg: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect(normalizeIncoming(msg)).toEqual([msg]);
  });

  it("normalizeIncoming passes an array through unchanged", () => {
    const msgs: JsonRpcMessage[] = [{ jsonrpc: "2.0", id: 1, method: "a" }, { jsonrpc: "2.0", id: 2, method: "b" }];
    expect(normalizeIncoming(msgs)).toBe(msgs);
  });

  it("resolveBatch drops the nulls that notifications produce", async () => {
    const frames = [frame("c2s", { jsonrpc: "2.0", id: 1, method: "ping" }), frame("s2c", { jsonrpc: "2.0", id: 1, result: "pong" })];
    const engine = new ReplayEngine({ frames });

    const responses = await resolveBatch(engine, [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);

    expect(responses).toHaveLength(1);
    expect(responses[0].result).toBe("pong");
  });

  it("resolveBatch returns an empty array when every message is a notification", async () => {
    const engine = new ReplayEngine({ frames: [] });
    const responses = await resolveBatch(engine, [{ jsonrpc: "2.0", method: "notifications/a" }]);
    expect(responses).toEqual([]);
  });
});
