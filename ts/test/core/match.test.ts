import { describe, it, expect } from "vitest";
import { calculateSimilarity, findSemanticMatch, matchStructural, numericCloseness, tokenJaccard, trigramDice } from "../../src/core/match.js";
import { JsonRpcMessage } from "../../src/core/types.js";

describe("Matching Tier", () => {
  it("matches identical structures while ignoring IDs", () => {
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "test" } };
    const recorded: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "test" } };

    expect(matchStructural(incoming, recorded)).toBe(true);
  });

  it("ignores MCP _meta parameters", () => {
    const incoming: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "test", _meta: { progressToken: "123" } },
    };
    const recorded: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "test" },
    };

    expect(matchStructural(incoming, recorded)).toBe(true);
  });

  it("normalizes empty params", () => {
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} };
    const recorded: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "resources/list" };

    expect(matchStructural(incoming, recorded)).toBe(true);
  });

  it("fails structural match on different data", () => {
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fetch" } };
    const recorded: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } };

    expect(matchStructural(incoming, recorded)).toBe(false);
  });

  it("is tolerant of key order (structural, not textual, equality)", () => {
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fetch", args: { b: 2, a: 1 } } };
    const recorded: JsonRpcMessage = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { args: { a: 1, b: 2 }, name: "fetch" } };

    expect(matchStructural(incoming, recorded)).toBe(true);
  });
});

describe("hard safety gate", () => {
  it("never matches tools/call across different tool names, even structurally close", () => {
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_file", path: "/tmp/x" } };
    const recorded: JsonRpcMessage = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file", path: "/tmp/x" } };

    expect(matchStructural(incoming, recorded)).toBe(false);
    expect(calculateSimilarity(incoming, recorded)).toBe(0);
  });

  it("never matches across different methods", () => {
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "resources/list" };
    const recorded: JsonRpcMessage = { jsonrpc: "2.0", id: 2, method: "tools/list" };

    expect(calculateSimilarity(incoming, recorded)).toBe(0);
  });

  it("never fuzzy-matches two different paths sharing a long literal prefix", () => {
    // Regression test: found via real-server testing against server-filesystem. Two
    // different files under the same long directory prefix scored deceptively high on
    // generic character/word similarity before this gate existed, risking one file's
    // content being confidently returned for a request naming a different file.
    const incoming: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read_text_file", path: "/home/user/projects/deja/data/other.txt" },
    };
    const recorded: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "read_text_file", path: "/home/user/projects/deja/data/config.txt" },
    };

    expect(calculateSimilarity(incoming, recorded)).toBe(0);
  });

  it("gates conservatively on any slash-containing string, even ordinary prose", () => {
    // The heuristic can't distinguish "this slash means a path" from "this slash means
    // prose", so it deliberately requires exact equality for any slash-containing value.
    // A missed fuzzy match (falls through to a clean "no match" error) is an acceptable
    // cost for guaranteeing a mismatched path/URI can never fuzzy-match.
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", message: "yes/no answer please" } };
    const recorded: JsonRpcMessage = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", message: "yes/no answer, please" } };

    expect(calculateSimilarity(incoming, recorded)).toBe(0);
  });

  it("still fuzzy-matches near-identical prose that contains no path-like separators", () => {
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", message: "please say hello" } };
    const recorded: JsonRpcMessage = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", message: "please say hellO" } };

    expect(calculateSimilarity(incoming, recorded)).toBeGreaterThan(0);
  });

  it("does not gate on paths that are identical", () => {
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_text_file", path: "/a/b/c.txt", extra: "x" } };
    const recorded: JsonRpcMessage = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_text_file", path: "/a/b/c.txt" } };

    // Same path on both sides -- the gate must not fire just because a path-shaped value is
    // present; only a genuine mismatch between two path-shaped values should force 0.
    expect(calculateSimilarity(incoming, recorded)).toBeGreaterThan(0);
  });
});

describe("semantic similarity primitives", () => {
  it("numericCloseness is 1 for equal numbers and decays with relative distance", () => {
    expect(numericCloseness(5, 5)).toBe(1);
    expect(numericCloseness(100, 101)).toBeGreaterThan(0.9);
    expect(numericCloseness(1, 1000)).toBeLessThan(0.1);
  });

  it("trigramDice is 1 for identical strings and 0 for wholly dissimilar ones", () => {
    expect(trigramDice("hello", "hello")).toBe(1);
    expect(trigramDice("hello world", "hxllo worlx")).toBeGreaterThan(0.5);
    expect(trigramDice("abc", "xyz")).toBe(0);
  });

  it("tokenJaccard ignores token order and rewards overlap", () => {
    expect(tokenJaccard("fetch the url", "the url fetch")).toBe(1);
    expect(tokenJaccard("alpha beta", "gamma delta")).toBe(0);
  });
});

describe("calculateSimilarity (semantic tier)", () => {
  it("returns 1.0 for a structural match", () => {
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fetch", url: "https://a.test" } };
    const recorded: JsonRpcMessage = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fetch", url: "https://a.test" } };

    expect(calculateSimilarity(incoming, recorded)).toBe(1);
  });

  it("scores near-identical params highly but not identically", () => {
    // Uses a prose-like "query" field rather than a path/URL: those are hard-gated to
    // exact-match below (two different paths are never "close enough" -- see the hard
    // safety gate tests), so this demonstrates genuine fuzzy scoring on a field where
    // near-equality is actually a meaningful signal.
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", query: "best pizza near me" } };
    const recorded: JsonRpcMessage = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", query: "best pizza near mee" } };

    const score = calculateSimilarity(incoming, recorded);
    expect(score).toBeGreaterThan(0.75);
    expect(score).toBeLessThan(1);
  });

  it("scores wildly different params low", () => {
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fetch", url: "https://example.com/aaa" } };
    const recorded: JsonRpcMessage = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fetch", url: "ftp://totally-different.internal/zzz" } };

    expect(calculateSimilarity(incoming, recorded)).toBeLessThan(0.5);
  });

  it("penalizes a missing key rather than ignoring it", () => {
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fetch", url: "https://a.test", extra: "x" } };
    const recorded: JsonRpcMessage = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fetch", url: "https://a.test" } };

    expect(calculateSimilarity(incoming, recorded)).toBeLessThan(1);
  });
});

describe("findSemanticMatch", () => {
  interface Candidate {
    id: string;
    msg: JsonRpcMessage;
  }

  const getMessage = (c: Candidate) => c.msg;

  it("returns the highest-scoring candidate at or above threshold", async () => {
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", query: "best pizza near me" } };
    const candidates: Candidate[] = [
      { id: "close", msg: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", query: "best pizza near mee" } } },
      { id: "far", msg: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", query: "completely unrelated topic" } } },
    ];

    const match = await findSemanticMatch(incoming, { candidates, getMessage, threshold: 0.75 });
    expect(match?.id).toBe("close");
  });

  it("returns null when nothing clears the threshold and there is no judge", async () => {
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", query: "alpha" } };
    const candidates: Candidate[] = [
      { id: "far", msg: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", query: "completely different topic entirely" } } },
    ];

    const match = await findSemanticMatch(incoming, { candidates, getMessage, threshold: 0.9 });
    expect(match).toBeNull();
  });

  it("escalates only the uncertain band to the judge, not everything below threshold", async () => {
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", query: "best pizza near me" } };
    const candidates: Candidate[] = [
      { id: "uncertain", msg: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", query: "best pizza near m" } } },
      { id: "hopeless", msg: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", query: "completely unrelated topic" } } },
    ];

    const judged: JsonRpcMessage[] = [];
    const judge = async (_incoming: JsonRpcMessage, recorded: JsonRpcMessage) => {
      judged.push(recorded);
      return { equivalent: true };
    };

    const match = await findSemanticMatch(incoming, { candidates, getMessage, threshold: 0.95, judge });

    expect(match?.id).toBe("uncertain");
    // The "hopeless" candidate's score is far below threshold - 0.15, so it should never reach the judge.
    expect(judged).toHaveLength(1);
  });

  it("never lets a judge approve a match across different tool names (hard gate wins first)", async () => {
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_file", path: "/x" } };
    const candidates: Candidate[] = [
      { id: "wrong-tool", msg: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file", path: "/x" } } },
    ];

    const judge = async () => ({ equivalent: true }); // a judge that (wrongly) says yes to everything
    const match = await findSemanticMatch(incoming, { candidates, getMessage, threshold: 0.5, judge });

    expect(match).toBeNull();
  });

  it("fails closed (returns null) when two different candidates tie for the top qualifying score", async () => {
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", query: "best pizza near me" } };
    // Two distinct candidates with byte-identical message content score identically against
    // any given incoming message -- a guaranteed, reproducible tie, not a contrived mock.
    const tiedMsg: JsonRpcMessage = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", query: "best pizza near mee" } };
    const candidates: Candidate[] = [
      { id: "first", msg: tiedMsg },
      { id: "second", msg: tiedMsg },
    ];

    const match = await findSemanticMatch(incoming, { candidates, getMessage, threshold: 0.75 });
    expect(match).toBeNull();
  });

  it("still returns the sole winner when only one candidate ties itself (no ambiguity)", async () => {
    const incoming: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", query: "best pizza near me" } };
    const candidates: Candidate[] = [
      { id: "close", msg: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", query: "best pizza near mee" } } },
      { id: "far", msg: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", query: "completely unrelated topic" } } },
    ];

    const match = await findSemanticMatch(incoming, { candidates, getMessage, threshold: 0.75 });
    expect(match?.id).toBe("close");
  });
});
