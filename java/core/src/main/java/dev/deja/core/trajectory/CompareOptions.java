package dev.deja.core.trajectory;

import lombok.Builder;

/** @param threshold minimum deterministic similarity score to accept a sequence-mode match.
 *                    Default 0.75. Unused in {@code policy} mode (see {@link PolicyStepMatcher#argsMatch}).
 *  @param policy    required when {@code mode} is {@link TrajectoryMode#POLICY} */
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
