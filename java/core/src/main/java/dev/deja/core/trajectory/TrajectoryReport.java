package dev.deja.core.trajectory;

import dev.deja.core.trajectory.Frontier.TrajectorySession;

import java.util.List;

/** @param session absent when the actual cassette carries no replay-miss evidence to derive
 *                 this from */
public record TrajectoryReport(
        int reportVersion,
        TrajectoryMode mode,
        double threshold,
        List<TrajectoryStepReport> steps,
        TrajectorySession session,
        TrajectorySummary summary) {

    public static final int CURRENT_VERSION = 1;
}
