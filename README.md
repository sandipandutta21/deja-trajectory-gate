# deja-trajectory-gate

**Replay the environment. Gate the agent.**

Freeze a recorded MCP world, run a changed model, prompt, rule, or tool against it, and fail CI
when the resulting trajectory of tool calls diverges from what you approved. That's the whole
job: not "did the agent's trace look reasonable," but "does it still do what the last approved
version did, against the exact same environment."

This project grew out of [deja](https://github.com/sandipandutta21/deja), an MCP record/replay
VCR — the cassette format and the matching engine underneath are the same byte-compatible
artifact, tested the same way. This repository is where that Trajectory Gate work is now
maintained on its own, separate from deja's general-purpose record/replay history.

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

Trajectory Gate does both, from one artifact: capture the MCP wire once, replay that frozen world
for a changed agent, then align and gate the trajectory it actually produced. The gate verdict
itself is deterministic by construction, not just by default — `deja trajectory`/`deja gate`
have no judge parameter at all, so no vendor owns what "equivalent" means and a CI run can never
flake on an LLM call. The *replay* layer underneath (deciding what response to serve for one
request) separately supports an optional, bring-your-own judge as a tiebreaker inside a narrow
uncertainty band — but that's opt-in library code a caller writes themselves, with no CLI flag,
and it can't reach a gate's pass/fail decision either way.

That replay still has to survive a non-deterministic client: the same *intent* ("read this
file") can arrive as structurally different JSON-RPC calls between runs. A naive VCR either
matches too strictly (the recording rots the moment an agent phrases a call slightly
differently) or too loosely (a fuzzy matcher risks confidently returning the wrong tool's
content for a request that only looks similar). The matching tier ladder — exact → structural →
deterministic semantic similarity — with hard safety gates against exactly that failure mode, is
what makes the replay trustworthy enough to gate on.

## Highlights

- **Trajectory Gate**: freeze a recorded MCP environment, run a changed agent against it, and
  fail CI when its tool-call trajectory diverges. `deja trajectory` compares two already-captured
  sessions directly; `deja gate` owns the whole run (start replay, spawn the agent with
  `DEJA_MCP_URL`, capture, compare) in one command. Comparison modes: `strict`, `unordered`,
  `subset`, `superset`, and `policy` (explicit required/prohibited/optional steps). A replay miss
  establishes a divergence frontier — downstream observations are reported as consequences of it,
  not independent regressions. `strict` mode also classifies genuine reorders (two calls that
  just swapped position) as a distinct outcome instead of a disconnected missing+added pair.
  Safe `--update` promotes a captured session to a new golden only when there were zero replay
  misses.
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
  SDK's `McpClient` run **unmodified** against a cassette, with `gate = true` gating the same way
  `withGate()` does and `DEJA_MODE=record` re-recording the identical test code against a real
  server.
- **Validated against real servers**, not just fixtures: both implementations are tested
  directly against the official MCP reference servers (`server-everything`,
  `server-filesystem`), which is how several of the correctness fixes in this codebase were
  actually found.

## Repository layout

```
deja-trajectory-gate/
├── ts/            TypeScript implementation: CLI (deja record/replay/verify/diff/redact/
│                  trajectory/gate) + library + Vitest integration
├── java/          Java implementation: deja-core (native engine), deja-junit5 (JUnit 5
│                  @Cassette extension), and cli (the trajectory/gate CLI for Java --
│                  record/replay/verify/diff/redact CLI parity remains TS-only), a Gradle
│                  multi-module build
├── conformance/   Cassette fixtures shared by both test suites, proving the two
│                  implementations read and write byte-compatible files, plus the
│                  Trajectory Gate comparison vectors (conformance/trajectory/)
├── LICENSE
└── README.md      you are here
```

## Trajectory Gate

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
example — this repo's own CI gates it on every PR.

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

The Java side runs the identical CLI:

```bash
cd java
./gradlew :cli:installDist

java/cli/build/install/cli/bin/cli trajectory golden.jsonl actual.jsonl --mode strict
java/cli/build/install/cli/bin/cli gate golden.jsonl -- node your-agent.js
```

That's not a parallel reimplementation on faith: the Java CLI has been run directly against
TypeScript's own `ts/examples/gate-dogfood` fixture and produces an identical pass, and both
languages' JSON output is checked tree-identical (byte-identical for the `exact` vector) against
the same 10 conformance vectors in [`conformance/trajectory/`](conformance/trajectory/).

Or from a JUnit 5 test suite:

```java
@Cassette(
        value = "src/test/resources/fixtures/refund-flow.jsonl",
        gate = true)
class RefundFlowGateTest {

    @Test
    void filesATicketForARefund(McpSession session) {
        McpSyncClient client = session.connect(); // the real MCP Java SDK client, unmodified
        runMyAgent(client, "customer wants a refund");
        // afterEach compares the captured trajectory against the golden and fails the test
        // if it diverges -- no separate assertion needed.
    }
}
```

See [`ts/`](ts/) and [`java/`](java/) for the full set of comparison modes
(`strict`/`unordered`/`subset`/`superset`/`policy`) and `--update` semantics.

## Quick start: TypeScript

Trajectory Gate is built on plain MCP record/replay, which also works standalone:

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

See [`java/`](java/) for the module breakdown, and the [Trajectory Gate](#trajectory-gate)
section above for `@Cassette(gate = true)` and the Java `trajectory`/`gate` CLI. Plain
`record`/`replay`/`verify`/`diff`/`redact` CLI commands remain TS-only.

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

Trajectory Gate's actual claim is that its pass/fail verdict on a whole multi-step run is
trustworthy — specifically, that it doesn't silently pass a genuine behavioral regression. That's
backed by a generated corpus, not the 10 hand-authored conformance vectors: 10 realistic
multi-step agent flows across six tool families (filesystem, database, GitHub, financial, generic
API, protocol-level), each run through transforms — identical, tolerated argument noise, genuine
reorders, dropped/added/duplicated calls, dangerous argument drift, tool swaps, policy
required/prohibited checks — scored against every comparison mode that transform is actually
meant to exercise.

```
Trajectory Gate Benchmark v1

1,520 labeled golden/actual trajectory pairs

Precision    Recall    False Positives
100.0%       98.9%       0.0%
```

**Precision** = of trajectories the gate passed, how many were genuinely fine. **Recall** = of
genuinely fine trajectories, how many the gate correctly passed (the other 1.1% are false alarms
on a benign variation — costs a rerun, not a regression). **False positives** = of genuine
divergences (a dropped call, a swapped tool, a 10x change to a money transfer, a prohibited
call), how many the gate silently passed anyway — the number that matters most, because that's a
regression that ships to CI with no red flag, and this benchmark found zero. The by-category
breakdown, the one known limitation it did surface (an optional argument added to an
otherwise-empty-params call, e.g. `tools/list`, can score just under threshold — the same gap
`benchmarks/RESULTS.md` already documents at the single-request layer, not a new one), and every
disagreement, are in
[`ts/benchmarks/TRAJECTORY-RESULTS.md`](ts/benchmarks/TRAJECTORY-RESULTS.md). The corpus generator
is in
[`ts/benchmarks/trajectory-corpus.mjs`](ts/benchmarks/trajectory-corpus.mjs); regenerate with
`npm run benchmark:trajectory` from `ts/`.

That trajectory-level verdict is only as trustworthy as the request-matching layer underneath it
— the tier ladder deciding whether one recorded request and one incoming request are "the same
call" in the first place. That's backed by its own, larger generated corpus:

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

The full report, including a by-category breakdown and, honestly, the two specific kinds of case
the deterministic tier still can't safely catch (small-magnitude-but-consequential numeric drift,
and opaque identifiers like UUIDs/emails/hashes that aren't path/URI-shaped), is in
[`ts/benchmarks/RESULTS.md`](ts/benchmarks/RESULTS.md). The corpus generator, every transform, and
the rationale behind each category is in
[`ts/benchmarks/corpus.mjs`](ts/benchmarks/corpus.mjs); regenerate with `npm run benchmark` from
`ts/`.

Trajectory Gate also carries a smaller, exact conformance bar on top of both benchmarks above:
all 10 hand-authored comparison vectors in [`conformance/trajectory/`](conformance/trajectory/) —
exact match, tolerated drift, drifted, reordered, duplicate calls, unordered ambiguity, subset,
superset, replay-frontier, and threshold-boundary cases — produce tree-identical JSON reports in
both TypeScript and Java, `npx vitest run` reports 201/201 passing, and `./gradlew build` is
clean across all three Java modules (`deja-core`, `deja-junit5`, `cli`).

## License

MIT © Sandipan Dutta. See [LICENSE](LICENSE).
