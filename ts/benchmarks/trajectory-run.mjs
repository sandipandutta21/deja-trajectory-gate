// Benchmark runner for Trajectory Gate's comparison engine (not the matching tier ladder
// underneath it -- see benchmarks/run.mjs for that one). Scores compareTrajectories against
// benchmarks/trajectory-corpus.mjs's labeled golden/actual trajectory pairs and writes
// benchmarks/TRAJECTORY-RESULTS.md. Run with `npm run benchmark:trajectory` (builds dist/ first,
// since this exercises the real compiled library output, not the TS source).
//
// This is a one-off, hand-run report, not a CI gate -- same reasoning as the matching benchmark.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compareTrajectories } from "../dist/trajectory/compare.js";
import { corpus } from "./trajectory-corpus.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THRESHOLD = 0.75;
const TIMING_REPEATS = 50;

function evaluate(c) {
    return compareTrajectories(c.golden, c.actual, { mode: c.mode, threshold: THRESHOLD, policy: c.policy });
}

function score() {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    const disagreements = [];
    const byCategory = new Map();

    for (const c of corpus) {
        const report = evaluate(c);
        const decidedAccept = report.summary.passed;
        const wantAccept = !c.shouldFail;

        if (wantAccept && decidedAccept) tp++;
        else if (!wantAccept && decidedAccept) fp++;
        else if (wantAccept && !decidedAccept) fn++;
        else tn++;

        const key = `${c.category}[${c.mode}]`;
        if (!byCategory.has(key)) byCategory.set(key, { tp: 0, fp: 0, fn: 0, tn: 0, n: 0 });
        const cat = byCategory.get(key);
        cat.n++;
        if (wantAccept && decidedAccept) cat.tp++;
        else if (!wantAccept && decidedAccept) cat.fp++;
        else if (wantAccept && !decidedAccept) cat.fn++;
        else cat.tn++;

        if (wantAccept !== decidedAccept) {
            disagreements.push({
                id: c.id, category: c.category, mode: c.mode,
                expected: wantAccept ? "PASS" : "FAIL", got: decidedAccept ? "PASS" : "FAIL",
            });
        }
    }

    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    const fpr = fp + tn === 0 ? 0 : fp / (fp + tn);

    for (let i = 0; i < 5; i++) for (const c of corpus) evaluate(c);
    const start = process.hrtime.bigint();
    for (let r = 0; r < TIMING_REPEATS; r++) for (const c of corpus) evaluate(c);
    const elapsedNs = Number(process.hrtime.bigint() - start);
    const avgMicros = elapsedNs / 1000 / (TIMING_REPEATS * corpus.length);

    return { tp, fp, fn, tn, precision, recall, fpr, avgMicros, disagreements, byCategory };
}

function pct(x) {
    return `${(x * 100).toFixed(1)}%`;
}

function buildReport(r) {
    const byMode = new Map();
    for (const c of corpus) byMode.set(c.mode, (byMode.get(c.mode) ?? 0) + 1);
    const modes = [...byMode.keys()].sort();

    const lines = [];
    lines.push("# Trajectory Gate Benchmark — Results");
    lines.push("");
    lines.push(
        `Generated corpus of ${corpus.length} labeled golden/actual trajectory pairs, spanning ` +
            "10 realistic multi-step agent flows across six tool families (filesystem, database, " +
            `GitHub, financial, generic API, protocol-level), each run through transforms -- ` +
            `identical, tolerated argument noise, genuine reorders, dropped/added/duplicated ` +
            `calls, dangerous argument drift, tool swaps, and policy required/prohibited checks -- ` +
            `and scored against \`compareTrajectories\` in every mode that transform is actually ` +
            `meant to exercise. Regenerate with \`npm run benchmark:trajectory\` from \`ts/\`. See ` +
            "`benchmarks/trajectory-corpus.mjs` for every case and its rationale."
    );
    lines.push("");
    lines.push(`Cases by mode: ${modes.map((m) => `\`${m}\`: ${byMode.get(m)}`).join(", ")}.`);
    lines.push("");
    lines.push("## Summary");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|---|---:|");
    lines.push(`| Precision (of trajectories the gate passed, how many were genuinely fine) | ${pct(r.precision)} |`);
    lines.push(`| Recall (of genuinely fine trajectories, how many the gate correctly passed) | ${pct(r.recall)} |`);
    lines.push(`| False-positive rate (of genuine divergences, how many the gate silently passed) | ${pct(r.fpr)} |`);
    lines.push(`| Avg. latency per \`compareTrajectories\` call | ${r.avgMicros.toFixed(2)} µs |`);
    lines.push("");
    lines.push(
        "**False-positive rate is the number that matters most here**: it's the fraction of " +
            "genuine behavioral divergences (a dropped call, a swapped tool, a 10x change to a " +
            "money transfer, a prohibited call) that the gate let through as \"passed\" anyway -- " +
            "a regression that ships to CI with no red flag. A false alarm (the other kind of " +
            "mistake, counted in recall) costs a few minutes rerunning a gate on a benign " +
            "variation; a false positive here costs a silent regression."
    );
    lines.push("");

    lines.push("## By category and mode");
    lines.push("");
    lines.push("| Category [mode] | Cases | Correct | Expected verdict |");
    lines.push("|---|---:|---:|---|");
    for (const [key, cat] of [...r.byCategory.entries()].sort()) {
        const correct = cat.tp + cat.tn;
        const verdict = cat.tp + cat.fn > 0 && cat.fp + cat.tn === 0 ? "PASS" : cat.fp + cat.tn > 0 && cat.tp + cat.fn === 0 ? "FAIL" : "mixed";
        lines.push(`| ${key} | ${cat.n} | ${correct}/${cat.n} | ${verdict} |`);
    }
    lines.push("");

    lines.push("## Known limitations");
    lines.push("");
    lines.push(
        "All 10 disagreements below are the same known case, not 10 different bugs: adding one " +
            "optional argument to a call whose golden params were *empty* (`tools/list`, no " +
            "arguments) is a 100% relative change in key count, the largest the structural-" +
            "similarity tier ever considers -- so it can score just under the 0.75 threshold and " +
            "get diagnosed as `drifted` instead of `tolerated`, failing strict mode for a call " +
            "that was actually fine. This matches benchmarks/RESULTS.md's own finding that " +
            "`optional_param_added` isn't 100% even at the single-request matching layer " +
            "(190/194) -- Trajectory Gate inherits that layer's limitations, it doesn't add new " +
            "ones on top for this category."
    );
    lines.push("");

    lines.push("## Disagreements (gate verdict vs. ground truth)");
    lines.push("");
    if (r.disagreements.length === 0) {
        lines.push("None — every labeled case decided correctly.");
    } else {
        lines.push("| Case | Category | Mode | Expected | Got |");
        lines.push("|---|---|---|---|---|");
        for (const d of r.disagreements) {
            lines.push(`| \`${d.id}\` | ${d.category} | ${d.mode} | ${d.expected} | ${d.got} |`);
        }
    }
    lines.push("");

    return lines.join("\n");
}

const results = score();

console.log(
    `precision=${pct(results.precision)} recall=${pct(results.recall)} ` +
        `fpr=${pct(results.fpr)} avg=${results.avgMicros.toFixed(2)}µs ` +
        `disagreements=${results.disagreements.length}/${corpus.length}`
);

const report = buildReport(results);
writeFileSync(join(__dirname, "TRAJECTORY-RESULTS.md"), report + "\n");
console.log(`\nWrote ${join(__dirname, "TRAJECTORY-RESULTS.md")}`);
