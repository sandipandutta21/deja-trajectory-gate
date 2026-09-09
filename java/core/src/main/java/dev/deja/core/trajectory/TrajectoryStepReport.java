package dev.deja.core.trajectory;

/** Field order matches the canonical report's declared key order exactly --
 *  {@link Report} relies on this when building the canonical JSON tree. */
public record TrajectoryStepReport(
        Integer goldenIndex,
        Integer actualIndex,
        StepOutcome outcome,
        String method,
        String toolName,
        Double score,
        MatchTier tier,
        Phase phase) {
}
