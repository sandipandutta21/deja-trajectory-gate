package dev.deja.core.trajectory;

import lombok.Builder;

/**
 * Deliberately has no judge field: trajectory comparison ({@code deja trajectory}/{@code deja
 * gate}) is fully deterministic by construction, not merely "off by default." An LLM judge only
 * exists on the replay side (deciding what response to serve for one request) and requires a
 * caller to hand-write and pass in their own callback -- an explicit opt-in with no CLI surface.
 * A gate verdict can never be influenced by one.
 *
 * @param threshold minimum deterministic similarity score to accept a sequence-mode match.
 *                    Default 0.75. Unused in {@code policy} mode (see {@link PolicyStepMatcher#argsMatch}).
 * @param policy    required when {@code mode} is {@link TrajectoryMode#POLICY} */
@Builder
public record CompareOptions(TrajectoryMode mode, Double threshold, TrajectoryPolicy policy) {

    static final double DEFAULT_THRESHOLD = 0.75;

    public TrajectoryMode modeOrDefault() {
        return mode != null ? mode : TrajectoryMode.STRICT;
    }

    public double thresholdOrDefault() {
        return threshold != null ? threshold : DEFAULT_THRESHOLD;
    }
}
