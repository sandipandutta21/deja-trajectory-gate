import { readFile, writeFile } from "node:fs/promises";
import { CassetteReader } from "../core/cassette.js";
import { CompareCassetteFramesOptions, compareCassetteFrames } from "../trajectory/compare.js";
import { extractTrajectory } from "../trajectory/extract.js";
import { derivePolicy } from "../trajectory/policy.js";
import { TrajectoryPolicy, TrajectoryReport } from "../trajectory/types.js";

/**
 * Compares a golden cassette's trajectory against a candidate's.
 * Pure: returns a report rather than printing or exiting -- same convention as `diffCassettes`/
 * `verifyCassette`, so the CLI layer owns presentation and exit codes.
 */
export async function compareTrajectoryCassettes(
    goldenPath: string,
    actualPath: string,
    options: CompareCassetteFramesOptions = {}
): Promise<TrajectoryReport> {
    const golden = await new CassetteReader(goldenPath).loadAll();
    const actual = await new CassetteReader(actualPath).loadAll();
    return compareCassetteFrames(golden.frames, actual.frames, options);
}

/** `--derive-policy`: seeds a starting policy from a golden cassette alone. */
export async function deriveTrajectoryPolicy(goldenPath: string, outputPath: string): Promise<TrajectoryPolicy> {
    const golden = await new CassetteReader(goldenPath).loadAll();
    const policy = derivePolicy(extractTrajectory(golden.frames));
    await writeFile(outputPath, JSON.stringify(policy, null, 2) + "\n", "utf8");
    return policy;
}

export async function readTrajectoryPolicy(path: string): Promise<TrajectoryPolicy> {
    return JSON.parse(await readFile(path, "utf8")) as TrajectoryPolicy;
}
