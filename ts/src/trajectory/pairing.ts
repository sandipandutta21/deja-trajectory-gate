import { calculateSimilarity, matchStructural } from "../core/match.js";
import { JsonRpcMessage, MatchingTier } from "../core/types.js";
import { TrajectoryStep } from "./types.js";

export interface PairScore {
    score: number;
    tier: MatchingTier;
    /** `score` clears `threshold` -- an "accepted" match, the primary alignment objective. */
    accepted: boolean;
}

function toMessage(step: TrajectoryStep): JsonRpcMessage {
    return { jsonrpc: "2.0", method: step.method, params: step.params as Record<string, unknown> | undefined };
}

/**
 * Scores a candidate golden/actual pair. Returns `null` when the pair is
 * ineligible to match at all -- different method, or (for `tools/call`) different tool name --
 * reusing `calculateSimilarity`'s own hard tool-identity gate (F3) so that rule has exactly one
 * implementation. An eligible pair always gets a score, even 0 (a hard content mismatch): a
 * same-tool call with wildly different arguments is still more informative paired up as
 * "drifted" than reported as two disconnected added/missing steps.
 */
export function scorePair(golden: TrajectoryStep, actual: TrajectoryStep, threshold: number): PairScore | null {
    if (golden.method !== actual.method) return null;
    if (golden.toolName !== actual.toolName) return null;

    const a = toMessage(golden);
    const b = toMessage(actual);

    if (matchStructural(a, b)) return { score: 1, tier: "exact", accepted: true };

    const score = calculateSimilarity(a, b);
    return { score, tier: "semantic", accepted: score >= threshold };
}
