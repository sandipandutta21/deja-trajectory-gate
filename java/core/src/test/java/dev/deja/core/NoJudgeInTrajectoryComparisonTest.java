package dev.deja.core;

import dev.deja.core.trajectory.Compare;
import dev.deja.core.trajectory.CompareOptions;
import dev.deja.core.trajectory.TrajectoryMode;
import dev.deja.core.trajectory.TrajectoryReport;
import dev.deja.core.trajectory.TrajectoryStep;
import org.junit.jupiter.api.Test;

import java.lang.reflect.RecordComponent;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Guards the claim in {@link CompareOptions}'s Javadoc: trajectory comparison ({@code deja
 * trajectory}/{@code deja gate}) is fully deterministic by construction, not merely "off by
 * default." Mirrors the TS side's equivalent test in {@code compare.test.ts}.
 */
class NoJudgeInTrajectoryComparisonTest {

    private static TrajectoryStep step(int index, String method, String toolName, Map<String, Object> params) {
        Map<String, Object> fullParams = toolName != null ? withName(toolName, params) : params;
        return new TrajectoryStep(index, method, toolName, fullParams, index, index);
    }

    private static Map<String, Object> withName(String toolName, Map<String, Object> params) {
        var merged = new java.util.LinkedHashMap<String, Object>();
        merged.put("name", toolName);
        merged.putAll(params);
        return merged;
    }

    @Test
    void compareOptionsHasNoJudgeFieldReflectively() {
        Set<String> fieldNames = java.util.Arrays.stream(CompareOptions.class.getRecordComponents())
                .map(RecordComponent::getName)
                .collect(Collectors.toSet());
        assertThat(fieldNames).containsExactlyInAnyOrder("mode", "threshold", "policy");
    }

    @Test
    void compareTrajectoriesIsFullySynchronous() {
        // TrajectoryReport, not a Future/CompletableFuture -- structurally cannot await an
        // async judge callback the way ReplayEngine.resolve (which does return a
        // CompletableFuture) can.
        List<TrajectoryStep> golden = List.of(step(0, "tools/call", "search", Map.of("q", "a")));
        List<TrajectoryStep> actual = List.of(step(0, "tools/call", "search", Map.of("q", "aa")));

        TrajectoryReport report = Compare.compareTrajectories(
                golden, actual, CompareOptions.builder().mode(TrajectoryMode.STRICT).build());

        assertThat(report).isNotNull();
    }
}
