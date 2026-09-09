import { stableStringify } from "../core/canon.js";
import { PolicyStepMatcher, TrajectoryPolicy, TrajectoryStep } from "./types.js";

function sameMethodAndTool(matcher: PolicyStepMatcher, step: TrajectoryStep): boolean {
    if (matcher.method !== step.method) return false;
    if (matcher.toolName !== undefined && matcher.toolName !== step.toolName) return false;
    return true;
}

/** Every key in `argsMatch` must deep-equal the step's corresponding param; extra params on the
 *  step that `argsMatch` doesn't mention are ignored -- a predicate, not a whole-object
 *  similarity score. */
function matchesArgsPredicate(params: unknown, argsMatch: Record<string, unknown> | undefined): boolean {
    if (!argsMatch) return true;
    if (typeof params !== "object" || params === null || Array.isArray(params)) return false;

    const obj = params as Record<string, unknown>;
    return Object.entries(argsMatch).every(([key, value]) => stableStringify(obj[key]) === stableStringify(value));
}

function matchesMatcher(matcher: PolicyStepMatcher, step: TrajectoryStep): boolean {
    return sameMethodAndTool(matcher, step) && matchesArgsPredicate(step.params, matcher.argsMatch);
}

/** First actual step (in trajectory order) satisfying `matcher`, or `undefined`. */
export function findPolicyMatch(matcher: PolicyStepMatcher, actual: TrajectoryStep[]): TrajectoryStep | undefined {
    return actual.find((step) => matchesMatcher(matcher, step));
}

/** Every actual step satisfying `matcher` -- used for `prohibited`, where any presence counts. */
export function findAllPolicyMatches(matcher: PolicyStepMatcher, actual: TrajectoryStep[]): TrajectoryStep[] {
    return actual.filter((step) => matchesMatcher(matcher, step));
}

/** True when some matcher in `matchers` covers `step` -- used to find untracked steps under
 *  `closedWorld`. */
export function isCoveredByAnyMatcher(step: TrajectoryStep, matchers: PolicyStepMatcher[]): boolean {
    return matchers.some((matcher) => matchesMatcher(matcher, step));
}

/**
 * Seeds a starting `TrajectoryPolicy` from a golden trajectory: every golden
 * step becomes a `required` matcher with a full `argsMatch` (its complete params), nothing is
 * `prohibited`, `closedWorld` defaults to `false`. A human edits it from there rather than deja
 * guessing intent.
 */
export function derivePolicy(golden: TrajectoryStep[]): TrajectoryPolicy {
    return {
        policyVersion: 1,
        required: golden.map((step) => ({
            method: step.method,
            toolName: step.toolName,
            argsMatch:
                step.params && typeof step.params === "object" && !Array.isArray(step.params)
                    ? (step.params as Record<string, unknown>)
                    : undefined,
        })),
        closedWorld: false,
    };
}
