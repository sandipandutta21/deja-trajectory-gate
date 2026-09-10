package dev.deja.cli.gate;

import dev.deja.core.cassette.CassetteFrame;
import dev.deja.core.cassette.CassetteHeader;
import dev.deja.core.cassette.CassetteReader;
import dev.deja.core.cassette.CassetteWriter;
import dev.deja.core.cassette.Direction;
import dev.deja.core.cassette.JsonRpcMessage;
import dev.deja.core.cassette.TransportType;
import dev.deja.core.trajectory.CompareOptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class RunGateTest {

    @TempDir
    Path tempDir;

    private static List<String> fixtureAgent(String behavior) {
        String javaBin = ProcessHandle.current().info().command().orElseThrow();
        String classpath = System.getProperty("java.class.path");
        return List.of(javaBin, "-cp", classpath, "dev.deja.cli.FixtureAgentMain", behavior);
    }

    private Path writeGolden(String name) {
        Path path = tempDir.resolve(name);
        try (CassetteWriter writer = new CassetteWriter(path)) {
            writer.write(CassetteHeader.of(Instant.now().toString(), TransportType.HTTP, null, null));
            writer.write(CassetteFrame.of(Direction.C2S, 0, JsonRpcMessage.request(1, "tools/list", null)));
            writer.write(CassetteFrame.of(Direction.S2C, 1, JsonRpcMessage.result(1, Map.of("tools", List.of()))));
        }
        return path;
    }

    @Test
    void passesWhenTheAgentsTrajectoryMatchesTheGolden() {
        Path golden = writeGolden("happy.jsonl");
        RunGate.Result result = RunGate.run(golden, fixtureAgent("happy"), RunGate.Options.builder().compareOptions(CompareOptions.builder().build()).build());

        assertThat(result.exitCode()).isEqualTo(0);
        assertThat(result.report()).isNotNull();
        assertThat(result.report().summary().passed()).isTrue();
        assertThat(result.reason()).isNull();
    }

    @Test
    void failsWithAComparisonReportWhenTheAgentsBehaviorDiverges() {
        Path golden = writeGolden("divergent.jsonl");
        RunGate.Result result = RunGate.run(golden, fixtureAgent("divergent"), RunGate.Options.builder().compareOptions(CompareOptions.builder().build()).build());

        assertThat(result.exitCode()).isEqualTo(1);
        assertThat(result.report().summary().passed()).isFalse();
        assertThat(result.report().session()).isNotNull();
        assertThat(result.report().session().replayMisses()).isEqualTo(1);
    }

    @Test
    void reportsAHarnessFailureWhenTheAgentExitsNonZero() {
        Path golden = writeGolden("failing.jsonl");
        RunGate.Result result = RunGate.run(golden, fixtureAgent("failing"), RunGate.Options.builder().compareOptions(CompareOptions.builder().build()).build());

        assertThat(result.exitCode()).isEqualTo(3);
        assertThat(result.report()).isNull();
        assertThat(result.reason()).contains("exited with code 7");
        assertThat(result.reasonCode()).isEqualTo(ReasonCode.AGENT_EXIT_NONZERO);
    }

    @Test
    @Timeout(10)
    void timesOutKillsTheAgentAndReportsAHarnessFailure() {
        Path golden = writeGolden("hanging.jsonl");
        long start = System.currentTimeMillis();
        RunGate.Result result = RunGate.run(golden, fixtureAgent("hanging"), RunGate.Options.builder()
                .compareOptions(CompareOptions.builder().build())
                .timeoutMs(200L)
                .build());

        assertThat(result.exitCode()).isEqualTo(3);
        assertThat(result.reason()).contains("timed out");
        assertThat(result.reasonCode()).isEqualTo(ReasonCode.TIMEOUT);
        // Proves the agent was actually killed rather than this test just waiting the full 5s.
        assertThat(System.currentTimeMillis() - start).isLessThan(4000);
    }

    @Test
    void updatePromotesTheCapturedSessionWhenThereWereNoReplayMisses() {
        Path golden = writeGolden("update-happy.jsonl");
        RunGate.Result result = RunGate.run(golden, fixtureAgent("happy"), RunGate.Options.builder()
                .compareOptions(CompareOptions.builder().build())
                .update(true)
                .build());

        assertThat(result.exitCode()).isEqualTo(0);
        assertThat(result.updated()).isTrue();

        var frames = new CassetteReader(golden).loadAll().frames();
        assertThat(frames.get(0).msg().method()).isEqualTo("tools/list");
    }

    @Test
    void updateRefusesToPromoteWhenTheAgentDivergedWithAReplayMiss() {
        Path golden = writeGolden("update-divergent.jsonl");
        RunGate.Result result = RunGate.run(golden, fixtureAgent("divergent"), RunGate.Options.builder()
                .compareOptions(CompareOptions.builder().build())
                .update(true)
                .build());

        assertThat(result.exitCode()).isEqualTo(1);
        assertThat(result.updated()).isFalse();

        var frames = new CassetteReader(golden).loadAll().frames();
        assertThat(frames.get(1).msg().result()).isEqualTo(Map.of("tools", List.of()));
    }

    // Windows' read-only file attribute doesn't reliably block the owning process from
    // overwriting a file the way POSIX permissions do -- this is a real test on Linux/macOS,
    // including the Linux CI runner this repo actually gates on, but not reproducible on a
    // Windows dev machine.
    @Test
    @org.junit.jupiter.api.condition.DisabledOnOs(org.junit.jupiter.api.condition.OS.WINDOWS)
    void updateFailsCleanlyInsteadOfCrashingWhenTheGoldenFileCantBeWritten() throws java.io.IOException {
        Path golden = writeGolden("update-write-failure.jsonl");
        golden.toFile().setReadOnly();
        try {
            RunGate.Result result = RunGate.run(golden, fixtureAgent("happy"), RunGate.Options.builder()
                    .compareOptions(CompareOptions.builder().build())
                    .update(true)
                    .build());

            assertThat(result.exitCode()).isEqualTo(3);
            assertThat(result.reasonCode()).isEqualTo(ReasonCode.UPDATE_WRITE_FAILED);
            assertThat(result.reason()).contains("Failed to update golden cassette");
        } finally {
            golden.toFile().setWritable(true);
        }
    }
}
