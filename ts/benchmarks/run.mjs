// Benchmark runner: scores three matchers against benchmarks/corpus.mjs's labeled cases
// and writes benchmarks/RESULTS.md. Run with `npm run benchmark` (builds dist/ first, since
// this deliberately exercises the real compiled library output, not the TS source).
//
// This is a one-off, hand-run report, not a CI gate -- see the README's Benchmark section
// for why that's a deliberate choice, not an oversight.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { matchStructural, calculateSimilarity } from "../dist/core/match.js";
import { corpus } from "./corpus.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THRESHOLD = 0.75;
const TIMING_REPEATS = 200; // repeated passes over the whole corpus, to get a stable average per call

/** The strawman every real VCR tool starts from: exact JSON equality, id aside. No key-order
 *  normalization, no _meta stripping -- deliberately naive, to quantify what deja's other two
 *  tiers actually buy over "just diff the JSON". */
function naiveExactMatch(a, b) {
    const strip = (m) => JSON.stringify({ ...m, id: undefined });
    return strip(a) === strip(b);
}

const matchers = [
    {
        key: "exact",
        name: "Exact (naive JSON equality)",
        decide: (c) => naiveExactMatch(c.incoming, c.recorded),
    },
    {
        key: "structural",
        name: "Structural only (deja tier 1/2)",
        decide: (c) => matchStructural(c.incoming, c.recorded),
    },
    {
        key: "full",
        name: "Deja full pipeline (tier 1/2/3 + hard gates)",
        decide: (c) => calculateSimilarity(c.incoming, c.recorded) >= THRESHOLD,
    },
];

function scoreMatcher(matcher) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    /** @type {Array<{ id: string, category: string, expected: string, got: string }>} */
    const disagreements = [];
    /** @type {Map<string, { tp: number, fp: number, fn: number, tn: number }>} */
    const byCategory = new Map();

    for (const c of corpus) {
        const decided = matcher.decide(c);
        const gotMatch = decided ? "MATCH" : "REJECT";
        const wantMatch = c.expected === "MATCH";

        if (wantMatch && decided) tp++;
        else if (!wantMatch && decided) fp++;
        else if (wantMatch && !decided) fn++;
        else tn++;

        if (!byCategory.has(c.category)) byCategory.set(c.category, { tp: 0, fp: 0, fn: 0, tn: 0 });
        const cat = byCategory.get(c.category);
        if (wantMatch && decided) cat.tp++;
        else if (!wantMatch && decided) cat.fp++;
        else if (wantMatch && !decided) cat.fn++;
        else cat.tn++;

        if (gotMatch !== c.expected) {
            disagreements.push({ id: c.id, category: c.category, expected: c.expected, got: gotMatch });
        }
    }

    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    const fpr = fp + tn === 0 ? 0 : fp / (fp + tn);

    // Warm up, then time: JS engines are noticeably slower on a function's first few calls.
    for (let i = 0; i < 10; i++) for (const c of corpus) matcher.decide(c);
    const start = process.hrtime.bigint();
    for (let r = 0; r < TIMING_REPEATS; r++) {
        for (const c of corpus) matcher.decide(c);
    }
    const elapsedNs = Number(process.hrtime.bigint() - start);
    const avgMicros = elapsedNs / 1000 / (TIMING_REPEATS * corpus.length);

    return { tp, fp, fn, tn, precision, recall, fpr, avgMicros, disagreements, byCategory };
}

function pct(x) {
    return `${(x * 100).toFixed(1)}%`;
}

function buildReport(results) {
    const totalMatch = corpus.filter((c) => c.expected === "MATCH").length;
    const totalReject = corpus.filter((c) => c.expected === "REJECT").length;
    const categories = [...new Set(corpus.map((c) => c.category))];

    const lines = [];
    lines.push("# Deja Matching Benchmark — Results");
    lines.push("");
    lines.push(
        `Hand-labeled corpus of ${corpus.length} JSON-RPC (recorded, incoming) pairs — ` +
            `${totalMatch} that should replay (\`MATCH\`) and ${totalReject} that must not ` +
            `(\`REJECT\`) — scored against three matchers. Regenerate with \`npm run benchmark\` ` +
            `from \`ts/\`. See \`benchmarks/corpus.mjs\` for every case and its rationale.`
    );
    lines.push("");
    lines.push("## Summary");
    lines.push("");
    lines.push("| Matcher | Precision | Recall | False-positive rate | Avg. latency/call |");
    lines.push("|---|---:|---:|---:|---:|");
    for (const [matcher, r] of results) {
        lines.push(
            `| ${matcher.name} | ${pct(r.precision)} | ${pct(r.recall)} | ${pct(r.fpr)} | ${r.avgMicros.toFixed(2)} µs |`
        );
    }
    lines.push("");
    lines.push(
        "**Precision** = correct matches ÷ all matches made. **Recall** = correct matches ÷ " +
            "cases that should have matched. **False-positive rate** = incorrect matches ÷ cases " +
            "that should have been rejected — the number that matters most here: a wrong match " +
            "means replaying the wrong tool's result, or (worse) nothing stopped a mutating call " +
            "with the wrong arguments from looking \"already handled.\""
    );
    lines.push("");

    lines.push("## By category");
    lines.push("");
    lines.push(`| Category | Cases | ${results.map(([m]) => m.name).join(" | ")} |`);
    lines.push(`|---|---:|${results.map(() => "---").join("|")}|`);
    for (const category of categories) {
        const n = corpus.filter((c) => c.category === category).length;
        const cells = results.map(([, r]) => {
            const cat = r.byCategory.get(category);
            const correct = cat.tp + cat.tn;
            return `${correct}/${n} correct`;
        });
        lines.push(`| ${category} | ${n} | ${cells.join(" | ")} |`);
    }
    lines.push("");

    lines.push("## Known limitations");
    lines.push("");
    lines.push(
        "The full pipeline's remaining false positives (see disagreements below) cluster into " +
            "two kinds of case a domain-agnostic deterministic matcher fundamentally cannot " +
            "distinguish from a safe one, without field-level semantics it doesn't have:"
    );
    lines.push("");
    lines.push(
        "- **Small-magnitude but consequential numeric drift** — a 10% change to a money " +
            "transfer, an off-by-one on a destructive range's boundary. The hard gate only fires " +
            "on a *large* relative change (below 50% closeness); a smaller one is indistinguishable, " +
            "on numbers alone, from a benign paging/retry-count nudge."
    );
    lines.push(
        "- **Opaque identifiers that aren't path/URI-shaped** — a UUID, an email address, a git " +
            "SHA, a bare numeric id differing by one character. The path/URI hard gate only " +
            "recognizes slash-shaped strings as opaque; a one-character change to a UUID and a " +
            "one-character typo in a search query look identical to character-level similarity."
    );
    lines.push(
        "");
    lines.push(
        "Both are real gaps, not edge cases invented to pad this list — see the disagreements " +
            "below for the exact cases. Closing them generically would need either per-field " +
            "semantics (which arguments are identifiers vs. free text) that deja does not have " +
            "today, or leaning on the optional LLM judge tier — which, as implemented, only " +
            "engages for scores *below* threshold, not for these, which score confidently above it."
    );
    lines.push("");

    lines.push("## Disagreements (matcher vs. ground truth)");
    lines.push("");
    for (const [matcher, r] of results) {
        lines.push(`### ${matcher.name}`);
        lines.push("");
        if (r.disagreements.length === 0) {
            lines.push("None — every labeled case decided correctly.");
        } else {
            lines.push("| Case | Category | Expected | Got |");
            lines.push("|---|---|---|---|");
            for (const d of r.disagreements) {
                lines.push(`| \`${d.id}\` | ${d.category} | ${d.expected} | ${d.got} |`);
            }
        }
        lines.push("");
    }

    return lines.join("\n");
}

const results = matchers.map((m) => [m, scoreMatcher(m)]);

for (const [matcher, r] of results) {
    console.log(
        `${matcher.name}: precision=${pct(r.precision)} recall=${pct(r.recall)} ` +
            `fpr=${pct(r.fpr)} avg=${r.avgMicros.toFixed(2)}µs disagreements=${r.disagreements.length}`
    );
}

// Loose regression gate, not a strict any-change gate: last-known-good numbers for the full
// pipeline (the only matcher anyone would actually ship). A false-positive-rate *increase* is
// always a regression -- that's the number a wrong match actually costs. Precision/recall get
// a small tolerance band since those can wobble slightly without anything having gotten less
// safe. Deliberately not run by default -- pass `--check` (e.g. `npm run benchmark -- --check`)
// to enable it; see the CI workflow's own step for exactly that invocation.
const REGRESSION_BASELINE = { falsePositiveRate: 0.115, precision: 0.916, recall: 0.988 };
const REGRESSION_TOLERANCE = 0.01;
// The baseline above is the README's rounded display value, not the exact fraction (currently
// ~0.1155, not 0.115) -- a tiny tolerance absorbs that rounding without hiding a real
// regression, which would move this by far more than half a percentage point.
const FPR_TOLERANCE = 0.005;

if (process.argv.includes("--check")) {
    const full = results.find(([m]) => m.key === "full")[1];
    const problems = [];
    if (full.fpr > REGRESSION_BASELINE.falsePositiveRate + FPR_TOLERANCE) {
        problems.push(`false-positive rate rose to ${pct(full.fpr)} (baseline ${pct(REGRESSION_BASELINE.falsePositiveRate)})`);
    }
    if (full.precision < REGRESSION_BASELINE.precision - REGRESSION_TOLERANCE) {
        problems.push(`precision dropped to ${pct(full.precision)} (baseline ${pct(REGRESSION_BASELINE.precision)})`);
    }
    if (full.recall < REGRESSION_BASELINE.recall - REGRESSION_TOLERANCE) {
        problems.push(`recall dropped to ${pct(full.recall)} (baseline ${pct(REGRESSION_BASELINE.recall)})`);
    }
    if (problems.length > 0) {
        console.error(`\nBenchmark regression:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
        process.exit(1);
    }
    console.log("\nBenchmark regression check passed.");
}

const report = buildReport(results);
writeFileSync(join(__dirname, "RESULTS.md"), report + "\n");
console.log(`\nWrote ${join(__dirname, "RESULTS.md")}`);
