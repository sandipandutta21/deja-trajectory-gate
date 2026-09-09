# deja

**Replay the environment. Gate the agent.**

deja replays an agent's environment, not the agent: freeze a recorded MCP world, run a changed
model, prompt, rule, or tool against it, and fail CI when the resulting trajectory of tool calls
diverges from what you approved.

Under the hood, it's a full [MCP](https://modelcontextprotocol.io) record/replay proxy — the
cassette is a plain, inspectable JSONL artifact you can also use standalone, independent of
Trajectory Gate.

```text
The cassette is open.
The replay is offline.
The comparison is deterministic by default.
No model vendor owns the judge.
Nobody else combines wire-level environment replay with trajectory gating in one artifact.
```

One open cassette format, two independent language implementations (TypeScript and Java) that
read and write byte-compatible files, and native test integrations for both ecosystems.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![Java](https://img.shields.io/badge/java-17%2B-orange)
[![Maven Central](https://img.shields.io/maven-central/v/io.github.sandipandutta21/deja-core)](https://central.sonatype.com/artifact/io.github.sandipandutta21/deja-core)

## Why

Tracing and eval tools can tell you an agent's trajectory changed — but they start from a trace
someone already produced (OpenTelemetry, Langfuse, LangSmith, an SDK export) and can't
reconstruct the environment a *different* agent needs to make real decisions against. MCP-level
record/replay tools solve the opposite half: they can replay an identical client, but stop there
— no trajectory comparison, no CI gate.

deja does both, from one artifact: capture the MCP wire once, replay that frozen world for a
changed agent, then align and gate the trajectory it actually produced. Comparison is
deterministic by default — no LLM judge required, no vendor owns what "equivalent" means — with
an optional judge only as a tiebreaker inside a narrow uncertainty band.

That replay still has to survive a non-deterministic client: the same *intent* ("read this
file") can arrive as structurally different JSON-RPC calls between runs. A naive VCR either
matches too strictly (the recording rots the moment an agent phrases a call slightly
differently) or too loosely (a fuzzy matcher risks confidently returning the wrong tool's
content for a request that only looks similar). deja's matching tier ladder — exact → structural
→ deterministic semantic similarity — with hard safety gates against exactly that failure mode,
is what makes the replay trustworthy enough to gate on.

## Highlights

- **Trajectory Gate**: freeze a recorded MCP environment, run a changed agent against it, and
  fail CI when its tool-call trajectory diverges. `deja trajectory` compares two already-captured
  sessions directly; `deja gate` owns the whole run (start replay, spawn the agent with
  `DEJA_MCP_URL`, capture, compare) in one command. Comparison modes: `strict`, `unordered`,
  `subset`, `superset`, and `policy` (explicit required/prohibited/optional steps). A replay miss
  establishes a divergence frontier — downstream observations are reported as consequences of it,
  not independent regressions. Safe `--update` promotes a captured session to a new golden only
  when there were zero replay misses.
- **Recording**: transparent stdio proxy or Streamable HTTP proxy (SSE and pre-2025 batch
  arrays included); captures the full wire, including server-initiated traffic (notifications,
  sampling, elicitation); secret redaction on by default (GitHub/`sk-`/Slack/AWS/JWT/Bearer/
  URL-embedded credentials → deterministic, hashed placeholders).
- **Replay**: the cassette *is* the server, over stdio or HTTP; cross-transport (record over
  HTTP, replay over stdio, or vice versa); `--capture` tees the live session to a separate
  cassette (redacted, fresh timestamps) without ever mutating the golden; a matcher failure
  answers a clean JSON-RPC error for that one request instead of poisoning the whole session.
- **Matching, the differentiator**: exact → structural (key-order independent) → deterministic
  semantic (token Jaccard + trigram Dice + numeric closeness + recursive structural weighting) →
  optional bring-your-own LLM judge for the uncertain band only. Hard gates: `tools/call` never
  matches across different tool names, and path/URI-shaped parameters never fuzzy-match each
  other, however much of the string they share.
- **Contract gating**: `deja verify` replays a cassette against a *live* server and diffs
  responses field-by-field to catch drift; `deja diff` classifies breaking vs. minor changes
  between two cassettes (removed tools, newly-required params, result↔error flips, removed
  fields); `deja redact --scan` is a CI tripwire against committing an unredacted fixture.
- **Native test integrations**: `withGate()` and a zero-config `useCassette()` Vitest fixture on
  the TS side; a JUnit 5 `@Cassette` extension on the Java side that lets the official MCP Java
  SDK's `McpClient` run **unmodified** against a cassette, with `DEJA_MODE=record` re-recording
  the identical test code against a real server.
- **Validated against real servers**, not just fixtures: both implementations are tested
  directly against the official MCP reference servers (`server-everything`,
  `server-filesystem`), which is how several of the correctness fixes in this codebase were
  actually found.

## Repository layout

```
deja/
├── ts/            TypeScript implementation: CLI (deja record/replay/verify/diff/redact/
│                  trajectory/gate) + library + Vitest integration
├── java/          Java implementation: deja-core (native engine) + deja-junit5
│                  (JUnit 5 @Cassette extension), a Gradle multi-module build
├── conformance/   Cassette fixtures shared by both test suites, proving the two
│                  implementations read and write byte-compatible files, plus the
│                  Trajectory Gate comparison vectors (conformance/trajectory/)
├── LICENSE
└── README.md      you are here
```

## Trajectory Gate

Beyond record/replay, deja can gate an *agent's* behavior, not just a server's contract: freeze
a recorded MCP environment, run a changed agent against the exact same world, and fail CI when
its trajectory of tool calls diverges from what you approved.

```bash
cd ts
npm install
npm run build

# Compare two already-captured trajectories directly
npx deja trajectory golden.jsonl actual.jsonl --mode strict

# Or let deja own the whole run: start replay, spawn your agent with DEJA_MCP_URL set,
# capture its actual session, then compare -- one command
npx deja gate golden.jsonl -- node your-agent.js
```

`deja gate` starts an HTTP replay server over `golden.jsonl`, spawns `your-agent.js` with
`DEJA_MCP_URL` pointing at it, captures everything the agent actually did, and exits `0` (pass),
`1` (behavior diverged), `2` (usage error), or `3` (harness failure — timeout, crash, no
capture). See [`ts/examples/gate-dogfood`](ts/examples/gate-dogfood) for a minimal working
example — deja's own CI gates it on every PR.

Or from a test suite:

```ts
import { withGate } from "deja-mcp/vitest";

test(
  "files a ticket for a refund request",
  withGate("golden/refund-flow.jsonl", async ({ url }) => {
    await runMyAgent({ mcpUrl: url, prompt: "customer wants a refund" });
  })
);
```

See [`ts/`](ts/) for the full set of comparison modes (`strict`/`unordered`/`subset`/`superset`/
`policy`) and `--update` semantics.

## Quick start: TypeScript

The record/replay mechanism Trajectory Gate is built on also works standalone:

```bash
cd ts
npm install
npm run build

# Record a real session
npx deja record -o session.cassette.jsonl -- node your-mcp-server.js

# Replay it later, offline
npx deja replay session.cassette.jsonl
```

Or from a test suite, with zero subprocess in CI:

```ts
import { useCassette } from "deja-mcp/vitest";

const mcp = useCassette("fixtures/session.jsonl", {
  record: { command: ["node", "your-mcp-server.js"] },
});

test("lists tools", async () => {
  const client = await mcp.connect();
  const { tools } = await client.listTools();
  expect(tools).toContainEqual(expect.objectContaining({ name: "search" }));
});
```

See [`ts/`](ts/) for the full CLI reference.

## Quick start: Java

Published on Maven Central as `io.github.sandipandutta21:deja-core` (the engine, zero test-framework
dependency) and `io.github.sandipandutta21:deja-junit5` (adds the JUnit 5 `@Cassette` extension;
depends on `deja-core` transitively):

```kotlin
// your project's build.gradle.kts
dependencies {
    testImplementation("io.github.sandipandutta21:deja-junit5:0.1.1")
}
```

```java
@Cassette(
        value = "src/test/resources/fixtures/session.jsonl",
        record = {"node", "your-mcp-server.js"})
class YourServerTest {

    @Test
    void listsTools(McpSession session) {
        McpSyncClient client = session.connect(); // the real MCP Java SDK client, unmodified
        var tools = client.listTools();
        assertThat(tools.tools()).extracting(Tool::name).contains("search");
    }
}
```

See [`java/`](java/) for the module breakdown. Trajectory Gate (`deja trajectory`/`deja gate`) is
TypeScript-only for now; Java parity is planned but not yet implemented.

## The cassette format

A cassette is a JSONL file: one header line, then one line per captured frame.

```jsonl
{"type":"header","version":1,"recorded_at":"2026-01-01T00:00:00Z","transport":"stdio","server_command":["node","server.js"]}
{"type":"frame","dir":"c2s","t_ms":0,"msg":{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fetch","url":"https://example.com"}}}
{"type":"frame","dir":"s2c","t_ms":12,"msg":{"jsonrpc":"2.0","id":1,"result":{"ok":true}}}
```

It's a plain, versioned, language-agnostic format on purpose: [`conformance/`](conformance/)
holds fixtures written by one implementation and read by the other, including a proof that both
languages compute the *identical* redaction hash for the same secret. Trajectory Gate is a
derived view over this same format — no second recording format, no cassette schema changes.

## Benchmark

The matching tier ladder's actual claim, replaying semantically-equivalent-but-different requests
without introducing dangerous false matches, is backed by a generated (not hand-padded) corpus:
realistic base interactions across six tool families, run through role-aware transforms that only
fire where a suitable argument exists, each producing an explicit ground-truth label and rationale.

```
Replay Benchmark v1

1,733 labeled MCP request variations

                          Precision    Recall    False Positives
Exact matching              100%        20.0%      0.0%
Structural matching         100%        51.7%      0.0%
Deja full pipeline          91.6%       98.8%      11.5%

Tested across:
✓ Official MCP filesystem server (real integration tests)
✓ Official MCP everything server (real integration tests)
✓ Controlled request variations (this corpus)
✓ Dangerous near-misses (tool-name swaps, path/URI near-misses, numeric drift, opaque IDs)
```

False-positive rate is the number that matters most: a wrong match means replaying the wrong
tool's result, or worse, a mutating call with different arguments silently looking "already
handled." The full report, including a by-category breakdown and, honestly, the two specific
kinds of case the deterministic tier still can't safely catch (small-magnitude-but-consequential
numeric drift, and opaque identifiers like UUIDs/emails/hashes that aren't path/URI-shaped), is
in [`ts/benchmarks/RESULTS.md`](ts/benchmarks/RESULTS.md). The corpus generator, every transform,
and the rationale behind each category is in [`ts/benchmarks/corpus.mjs`](ts/benchmarks/corpus.mjs);
regenerate with `npm run benchmark` from `ts/`.

## License

MIT © Sandipan Dutta. See [LICENSE](LICENSE).
