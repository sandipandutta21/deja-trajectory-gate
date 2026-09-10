package dev.deja.core;

import dev.deja.core.trajectory.Compare;
import dev.deja.core.trajectory.CompareOptions;
import dev.deja.core.trajectory.TrajectoryMode;
import dev.deja.core.trajectory.TrajectoryStep;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Mirrors the TS side's equivalent tests in {@code compare.test.ts}. */
class TrajectorySizeGuardTest {

    private static TrajectoryStep step(int index, String toolName) {
        return new TrajectoryStep(index, "tools/call", toolName, Map.of("name", toolName), index, index);
    }

    @Test
    void throwsInsteadOfAttemptingAnOversizedComparison() {
        List<TrajectoryStep> big = new ArrayList<>();
        for (int i = 0; i < 5001; i++) {
            big.add(step(i, "x"));
        }
        assertThatThrownBy(() -> Compare.compareTrajectories(big, List.of(), CompareOptions.builder().build()))
                .hasMessageContaining("too large to compare");
    }

    @Test
    void doesNotThrowRightAtTheBoundary() {
        // Distinct tool names per step -- Hungarian solves each same-(method,toolName) group
        // independently, so this is 5000 trivial 1x1 assignments, not one 5000x5000 one.
        List<TrajectoryStep> atLimit = new ArrayList<>();
        for (int i = 0; i < 5000; i++) {
            atLimit.add(step(i, "tool-" + i));
        }

        var report = Compare.compareTrajectories(atLimit, List.copyOf(atLimit),
                CompareOptions.builder().mode(TrajectoryMode.UNORDERED).build());
        assertThat(report).isNotNull();
    }
}
