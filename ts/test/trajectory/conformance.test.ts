import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compareTrajectoryCassettes } from "../../src/command/trajectory.js";
import { toCanonicalReport } from "../../src/trajectory/report.js";

/**
 * Ten golden/actual vectors covering exact, tolerated, drifted, reordered, duplicate calls,
 * unordered ambiguity, subset, superset, replay frontier, and threshold boundary.
 * `expected-report.json` in each vector directory is the frozen, generated (via
 * `scripts/generate-trajectory-conformance.mjs`) canonical output -- a diff here means a
 * behavior change, intentional or not. The Java implementation runs these same fixtures too.
 */
const conformanceDir = resolve(process.cwd(), "../conformance/trajectory");

const vectors = readdirSync(conformanceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

describe("trajectory conformance vectors", () => {
    it("covers all ten required vectors", () => {
        expect(vectors).toEqual([
            "drifted",
            "duplicate-call",
            "exact",
            "reordered",
            "replay-frontier",
            "subset",
            "superset",
            "threshold-boundary",
            "tolerated",
            "unordered-ambiguity",
        ]);
    });

    for (const vector of vectors) {
        it(`${vector} matches its frozen expected-report.json`, async () => {
            const dir = resolve(conformanceDir, vector);
            const caseOptions = JSON.parse(readFileSync(resolve(dir, "case.json"), "utf8"));
            const expected = JSON.parse(readFileSync(resolve(dir, "expected-report.json"), "utf8"));

            const report = await compareTrajectoryCassettes(resolve(dir, "golden.jsonl"), resolve(dir, "actual.jsonl"), caseOptions);

            expect(toCanonicalReport(report)).toEqual(expected);
        });
    }
});
