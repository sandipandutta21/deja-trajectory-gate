import { MatchingTier } from "../core/types.js";

/** An asserted client action extracted from a cassette's wire frames. */
export interface TrajectoryStep {
    /** Position among included client actions. */
    index: number;

    /** JSON-RPC/MCP method. */
    method: string;

    /** Present only for `tools/call`. */
    toolName?: string;

    /** Canonical-comparison input (post `normalizeMessage`, so `_meta`/`id` already stripped). */
    params: unknown;

    /** Original wire provenance. Diagnostic only -- never a matching key. */
    frameIndex: number;
    tMs: number;
}

export interface TrajectoryExtractionOptions {
    /** Methods to additionally assert beyond the default inclusion policy. Additive: a method
     *  named here is included even if normally excluded (e.g. `initialize`). */
    include?: string[];
}

export type TrajectoryMode = "strict" | "unordered" | "subset" | "superset" | "policy";

export type StepOutcome =
    | "exact"
    | "tolerated"
    | "drifted"
    | "reordered"
    | "added"
    | "missing"
    | "required-satisfied"
    | "required-missing"
    | "prohibited-present"
    | "optional-observed"
    | "optional-absent";

export interface TrajectoryStepReport {
    goldenIndex?: number;
    actualIndex?: number;
    outcome: StepOutcome;
    method: string;
    toolName?: string;
    score?: number;
    tier?: MatchingTier;
    /** Only ever "post-divergence"; pre-divergence is the implicit default and is omitted. */
    phase?: "post-divergence";
}

export interface TrajectorySummary {
    passed: boolean;
    exact: number;
    tolerated: number;
    drifted: number;
    reordered: number;
    added: number;
    missing: number;
    requiredMissing: number;
    prohibitedPresent: number;
}

export interface TrajectorySession {
    replayMisses: number;
    firstMissFrameIndex?: number;
}

export interface TrajectoryReport {
    reportVersion: 1;
    mode: TrajectoryMode;
    threshold: number;
    steps: TrajectoryStepReport[];
    /** Absent when the actual cassette carries no replay-miss evidence to derive this from. */
    session?: TrajectorySession;
    summary: TrajectorySummary;
}

/** An explicit required/prohibited/optional behavior policy, the reference document for
 *  `policy` mode instead of a golden trajectory. */
export interface PolicyStepMatcher {
    method: string;
    toolName?: string;
    /** Exact per-key structural predicate over the step's params -- every listed key must
     *  deep-equal, extra params on the step are ignored. Not a fuzzy similarity score: a
     *  partial key/value predicate has no well-defined "similarity" against an object that may
     *  legitimately contain additional untested fields. */
    argsMatch?: Record<string, unknown>;
}

export interface TrajectoryPolicy {
    policyVersion: 1;
    required?: PolicyStepMatcher[];
    prohibited?: PolicyStepMatcher[];
    optional?: PolicyStepMatcher[];
    /** Steps matched by none of required/prohibited/optional are treated as prohibited. Default false. */
    closedWorld?: boolean;
}

/**
 * Deliberately has no `judge` field: trajectory comparison (`deja trajectory`/`deja gate`) is
 * fully deterministic by construction, not merely "off by default." An LLM judge only exists on
 * the replay side (`ReplayEngineOptions.semantic.judge`, deciding what response to serve for one
 * request) and requires a caller to hand-write and pass in their own callback -- an explicit
 * opt-in with no CLI surface. A gate verdict can never be influenced by one.
 */
export interface TrajectoryCompareOptions {
    mode?: TrajectoryMode;
    /** Minimum deterministic similarity score to accept a sequence-mode match. Default 0.75.
     *  Unused in `policy` mode (see `PolicyStepMatcher.argsMatch`). */
    threshold?: number;
    /** Required when `mode` is `"policy"`. */
    policy?: TrajectoryPolicy;
}
