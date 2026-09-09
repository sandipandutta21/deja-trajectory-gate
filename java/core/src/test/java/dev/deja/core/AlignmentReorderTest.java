package dev.deja.core;

import dev.deja.core.trajectory.Compare;
import dev.deja.core.trajectory.CompareOptions;
import dev.deja.core.trajectory.TrajectoryReport;
import dev.deja.core.trajectory.TrajectoryStep;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class AlignmentReorderTest {

    private static TrajectoryStep step(int index, String method, String toolName, Map<String, Object> params) {
        Map<String, Object> fullParams = toolName != null
                ? withName(toolName, params)
                : params;
        return new TrajectoryStep(index, method, toolName, fullParams, index, index);
    }

    private static TrajectoryStep step(int index, String method, String toolName) {
        return step(index, method, toolName, Map.of());
    }

    private static Map<String, Object> withName(String toolName, Map<String, Object> params) {
        var merged = new java.util.LinkedHashMap<String, Object>();
        merged.put("name", toolName);
        merged.putAll(params);
        return merged;
    }

    @Test
    void mergesASwappedPairOfCallsIntoOneReorderedEntryInsteadOfDisconnectedAddedMissing() {
        List<TrajectoryStep> golden = List.of(step(0, "tools/call", "lookup_customer"), step(1, "tools/call", "issue_refund"));
        List<TrajectoryStep> actual = List.of(step(0, "tools/call", "issue_refund"), step(1, "tools/call", "lookup_customer"));

        TrajectoryReport report = Compare.compareTrajectories(golden, actual, CompareOptions.builder().build());

        assertThat(report.summary().passed()).isFalse();
        assertThat(report.summary().reordered()).isEqualTo(1);
        assertThat(report.summary().exact()).isEqualTo(1);
        assertThat(report.summary().added()).isEqualTo(0);
        assertThat(report.summary().missing()).isEqualTo(0);
        assertThat(report.steps()).hasSize(2);
        assertThat(report.steps())
                .filteredOn(s -> "issue_refund".equals(s.toolName()))
                .singleElement()
                .satisfies(s -> {
                    assertThat(s.goldenIndex()).isEqualTo(1);
                    assertThat(s.actualIndex()).isEqualTo(0);
                    assertThat(s.outcome().wireValue()).isEqualTo("reordered");
                    assertThat(s.score()).isEqualTo(1.0);
                });
    }

    @Test
    void doesNotMergeAnAddedAndAMissingCallToDifferentTools() {
        List<TrajectoryStep> golden = List.of(step(0, "tools/call", "lookup_customer"));
        List<TrajectoryStep> actual = List.of(step(0, "tools/call", "send_email"));

        TrajectoryReport report = Compare.compareTrajectories(golden, actual, CompareOptions.builder().build());

        assertThat(report.summary().reordered()).isEqualTo(0);
        assertThat(report.summary().added()).isEqualTo(1);
        assertThat(report.summary().missing()).isEqualTo(1);
    }

    @Test
    void doesNotMergeASameToolPairWhoseArgumentsScoreBelowThreshold() {
        // A second, unrelated exact match (lookup_customer) is what makes the DP leave the
        // low-scoring "search" pair disconnected rather than matching it directly in place --
        // with only one step per side there'd be nothing to strand by matching it anyway.
        List<TrajectoryStep> golden = List.of(
                step(0, "tools/call", "lookup_customer"),
                step(1, "tools/call", "search", Map.of("q", "quarterly earnings report")));
        List<TrajectoryStep> actual = List.of(
                step(0, "tools/call", "search", Map.of("q", "completely unrelated weather forecast")),
                step(1, "tools/call", "lookup_customer"));

        TrajectoryReport report = Compare.compareTrajectories(
                golden, actual, CompareOptions.builder().threshold(0.99).build());

        assertThat(report.summary().reordered()).isEqualTo(0);
        assertThat(report.summary().added()).isEqualTo(1);
        assertThat(report.summary().missing()).isEqualTo(1);
        assertThat(report.summary().exact()).isEqualTo(1);
    }
}
