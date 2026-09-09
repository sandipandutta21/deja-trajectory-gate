#!/usr/bin/env node
// Regenerates conformance/trajectory/*/expected-report.json from each vector's golden.jsonl,
// actual.jsonl, and case.json (comparison options). Run after any change to trajectory
// comparison semantics that's an *intentional* behavior change; a diff in the output otherwise
// means something regressed.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compareTrajectoryCassettes } from "../dist/command/trajectory.js";
import { toCanonicalReport } from "../dist/trajectory/report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const conformanceDir = resolve(__dirname, "../../conformance/trajectory");

const vectors = (await readdir(conformanceDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

for (const vector of vectors) {
    const dir = resolve(conformanceDir, vector);
    const caseOptions = JSON.parse(await readFile(resolve(dir, "case.json"), "utf8"));

    const report = await compareTrajectoryCassettes(resolve(dir, "golden.jsonl"), resolve(dir, "actual.jsonl"), caseOptions);

    const canonical = toCanonicalReport(report);
    await writeFile(resolve(dir, "expected-report.json"), JSON.stringify(canonical, null, 2) + "\n", "utf8");
    console.log(`${vector}: passed=${report.summary.passed}`);
}
