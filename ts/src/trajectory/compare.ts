import { CassetteFrame } from "../core/types.js";
import { AlignedPair, alignStrict, alignUnordered, annotateReorders } from "./alignment.js";
import { extractTrajectory } from "./extract.js";
import { detectReplaySession } from "./frontier.js";
import { derivePolicy, findAllPolicyMatches, findPolicyMatch, isCoveredByAnyMatcher } from "./policy.js";
import {
    StepOutcome,
    TrajectoryCompareOptions,
    TrajectoryMode,
    TrajectoryPolicy,
    TrajectoryReport,
    TrajectorySession,
    TrajectoryStep,
    TrajectoryStepReport,
    TrajectorySummary,
} from "./types.js";

const DEFAULT_THRESHOLD = 0.75;

function emptySummary(): TrajectorySummary {
    return {
        passed: true,
        exact: 0,
        tolerated: 0,
        drifted: 0,
        reordered: 0,
        added: 0,
        missing: 0,
        requiredMissing: 0,
        prohibitedPresent: 0,
    };
}

/** A step is "post-divergence" only once we know an earlier actual request went unserved --
 *  derived from `detectReplaySession`, never asserted for golden-only entries. */
function phaseFor(step: TrajectoryStep | undefined, session: TrajectorySession | undefined): "post-divergence" | undefined {
    if (!step || session?.firstMissFrameIndex === undefined) return undefined;
    return step.frameIndex >= session.firstMissFrameIndex ? "post-divergence" : undefined;
}

function classifySequencePair(
    pair: AlignedPair,
    golden: TrajectoryStep[],
    actual: TrajectoryStep[],
    threshold: number,
    session: TrajectorySession | undefined
): TrajectoryStepReport {
    const goldenStep = pair.goldenIndex !== undefined ? golden[pair.goldenIndex] : undefined;
    const actualStep = pair.actualIndex !== undefined ? actual[pair.actualIndex] : undefined;
    const step = (goldenStep ?? actualStep)!;

    let outcome: StepOutcome;
    if (goldenStep && actualStep) {
        outcome = pair.reordered
            ? "reordered"
            : pair.score === 1
              ? "exact"
              : (pair.score ?? 0) >= threshold
                ? "tolerated"
                : "drifted";
    } else {
        outcome = goldenStep ? "missing" : "added";
    }

    return {
        goldenIndex: goldenStep?.index,
        actualIndex: actualStep?.index,
        outcome,
        method: step.method,
        toolName: step.toolName,
        score: pair.score,
        tier: pair.tier,
        phase: phaseFor(actualStep, session),
    };
}

/** `drifted` always fails; whether an unmatched side fails depends on mode (subset tolerates
 *  unmatched golden, superset tolerates unmatched actual, strict/unordered tolerate neither). */
function isSequenceFailure(outcome: StepOutcome, mode: TrajectoryMode): boolean {
    // Still a failure: the label improves diagnosis only, it never changes gate semantics.
    // annotateReorders only ever fires in strict mode, where this was already going to fail
    // as disconnected missing/added entries.
    if (outcome === "drifted" || outcome === "reordered") return true;
    if (outcome === "missing") return mode !== "subset";
    if (outcome === "added") return mode !== "superset";
    return false;
}

function buildSequenceReport(
    mode: TrajectoryMode,
    threshold: number,
    golden: TrajectoryStep[],
    actual: TrajectoryStep[],
    pairs: AlignedPair[],
    session: TrajectorySession | undefined
): TrajectoryReport {
    const summary = emptySummary();

    const steps = pairs.map((pair) => {
        const report = classifySequencePair(pair, golden, actual, threshold, session);
        switch (report.outcome) {
            case "exact":
                summary.exact++;
                break;
            case "tolerated":
                summary.tolerated++;
                break;
            case "drifted":
                summary.drifted++;
                break;
            case "reordered":
                summary.reordered++;
                break;
            case "missing":
                summary.missing++;
                break;
            case "added":
                summary.added++;
                break;
        }
        if (isSequenceFailure(report.outcome, mode)) summary.passed = false;
        return report;
    });

    return { reportVersion: 1, mode, threshold, steps, session, summary };
}

function evaluatePolicy(
    actual: TrajectoryStep[],
    policy: TrajectoryPolicy,
    session: TrajectorySession | undefined
): TrajectoryReport {
    const summary = emptySummary();
    const steps: TrajectoryStepReport[] = [];

    for (const matcher of policy.required ?? []) {
        const found = findPolicyMatch(matcher, actual);
        if (found) {
            steps.push({
                actualIndex: found.index,
                outcome: "required-satisfied",
                method: matcher.method,
                toolName: matcher.toolName,
                phase: phaseFor(found, session),
            });
        } else {
            summary.requiredMissing++;
            summary.passed = false;
            steps.push({ outcome: "required-missing", method: matcher.method, toolName: matcher.toolName });
        }
    }

    for (const matcher of policy.prohibited ?? []) {
        for (const found of findAllPolicyMatches(matcher, actual)) {
            summary.prohibitedPresent++;
            summary.passed = false;
            steps.push({
                actualIndex: found.index,
                outcome: "prohibited-present",
                method: matcher.method,
                toolName: matcher.toolName,
                phase: phaseFor(found, session),
            });
        }
    }

    for (const matcher of policy.optional ?? []) {
        const found = findPolicyMatch(matcher, actual);
        steps.push(
            found
                ? {
                      actualIndex: found.index,
                      outcome: "optional-observed",
                      method: matcher.method,
                      toolName: matcher.toolName,
                      phase: phaseFor(found, session),
                  }
                : { outcome: "optional-absent", method: matcher.method, toolName: matcher.toolName }
        );
    }

    if (policy.closedWorld) {
        const allMatchers = [...(policy.required ?? []), ...(policy.prohibited ?? []), ...(policy.optional ?? [])];
        for (const step of actual) {
            if (isCoveredByAnyMatcher(step, allMatchers)) continue;
            summary.prohibitedPresent++;
            summary.passed = false;
            steps.push({
                actualIndex: step.index,
                outcome: "prohibited-present",
                method: step.method,
                toolName: step.toolName,
                phase: phaseFor(step, session),
            });
        }
    }

    return { reportVersion: 1, mode: "policy", threshold: DEFAULT_THRESHOLD, steps, session, summary };
}

/** Above this, `unordered`/`subset`/`superset` mode's per-group Hungarian assignment (O(n³) in
 *  the size of the *largest same-(method,toolName) group*, not the trajectory as a whole) risks
 *  hanging on a pathological input rather than failing fast. Real trajectories -- an agent's
 *  actual tool calls in one run -- are tens to low hundreds of steps; this is headroom, not a
 *  realistic ceiling anyone should ever hit. */
const MAX_TRAJECTORY_STEPS = 5000;

function checkTrajectorySize(golden: TrajectoryStep[], actual: TrajectoryStep[]): void {
    if (golden.length > MAX_TRAJECTORY_STEPS || actual.length > MAX_TRAJECTORY_STEPS) {
        throw new Error(
            `Deja: trajectory too large to compare (golden ${golden.length} steps, actual ${actual.length} steps, max ${MAX_TRAJECTORY_STEPS} per side)`
        );
    }
}

/** Compares two already-extracted trajectories. `session` -- if the caller has
 *  divergence-frontier evidence (see `detectReplaySession`) -- tags post-divergence steps. */
export function compareTrajectories(
    golden: TrajectoryStep[],
    actual: TrajectoryStep[],
    options: TrajectoryCompareOptions = {},
    session?: TrajectorySession
): TrajectoryReport {
    checkTrajectorySize(golden, actual);
    const mode = options.mode ?? "strict";
    const threshold = options.threshold ?? DEFAULT_THRESHOLD;

    if (mode === "policy") {
        if (!options.policy) throw new Error("policy mode requires a policy document (see --policy / --derive-policy)");
        return evaluatePolicy(actual, options.policy, session);
    }

    const pairs =
        mode === "strict"
            ? annotateReorders(alignStrict(golden, actual, threshold), golden, actual, threshold)
            : alignUnordered(golden, actual, threshold);
    return buildSequenceReport(mode, threshold, golden, actual, pairs, session);
}

export interface CompareCassetteFramesOptions extends TrajectoryCompareOptions {
    /** Extraction inclusion overrides (`--include`) -- distinct from the `policy`
     *  comparison mode's `TrajectoryPolicy` despite the naming collision. */
    include?: string[];
}

/** Convenience entry point for the `deja trajectory` CLI: extracts both trajectories from raw
 *  wire frames and recovers divergence-frontier evidence from the actual cassette itself. */
export function compareCassetteFrames(
    goldenFrames: CassetteFrame[],
    actualFrames: CassetteFrame[],
    options: CompareCassetteFramesOptions = {}
): TrajectoryReport {
    const golden = extractTrajectory(goldenFrames, { include: options.include });
    const actual = extractTrajectory(actualFrames, { include: options.include });
    const session = detectReplaySession(actualFrames);
    return compareTrajectories(golden, actual, options, session);
}

export { derivePolicy };
