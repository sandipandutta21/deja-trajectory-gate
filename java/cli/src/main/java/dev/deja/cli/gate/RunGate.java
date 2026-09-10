package dev.deja.cli.gate;

import dev.deja.cli.http.HttpReplayServer;
import dev.deja.core.cassette.CassetteContents;
import dev.deja.core.cassette.CassetteFrame;
import dev.deja.core.cassette.CassetteHeader;
import dev.deja.core.cassette.CassetteReader;
import dev.deja.core.cassette.CassetteWriter;
import dev.deja.core.cassette.TransportType;
import dev.deja.core.trajectory.Compare;
import dev.deja.core.trajectory.CompareOptions;
import dev.deja.core.trajectory.TrajectoryReport;
import lombok.Builder;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * {@code deja gate}'s supported v1 lifecycle: load golden, start the HTTP replay
 * server with a capture tee, spawn the agent with {@code DEJA_MCP_URL}, wait for it to finish
 * (or time out), always close the listener/flush the capture, then extract+compare the
 * resulting trajectory. Mirrors the TypeScript implementation's {@code gate/run.ts}.
 *
 * <p>Pure-ish: returns a result rather than printing or exiting; the CLI layer owns
 * presentation and the process exit code. The one side effect this class itself performs is
 * {@code --update}'s cassette rewrite, gated by safe-update preconditions.
 */
public final class RunGate {

    private RunGate() {
    }

    /** 0 pass, 1 behavior diverged, 2 CLI usage/config error (the CLI layer owns
     *  this one), 3 harness/runtime failure. */
    @Builder
    public record Options(Integer port, CompareOptions compareOptions, Long timeoutMs, boolean update) {
    }

    /** @param report     absent when a harness failure ({@code reason}) happened before a
     *                    comparison was possible
     *  @param reason     set only for harness failures ({@code exitCode == 3})
     *  @param reasonCode set only for harness failures -- see {@link ReasonCode} */
    public record Result(int exitCode, TrajectoryReport report, String reason, ReasonCode reasonCode, boolean updated) {
        static Result harnessFailure(ReasonCode reasonCode, String reason) {
            return new Result(3, null, reason, reasonCode, false);
        }
    }

    public static Result run(Path goldenPath, List<String> command, Options options) {
        CassetteContents golden;
        try {
            golden = new CassetteReader(goldenPath).loadAll();
        } catch (RuntimeException e) {
            return Result.harnessFailure(ReasonCode.GOLDEN_READ_FAILED, "Unable to read golden cassette: " + e.getMessage());
        }

        Path capturePath = Path.of(System.getProperty("java.io.tmpdir"), "deja-gate-" + UUID.randomUUID() + ".jsonl");

        HttpReplayServer server;
        try {
            server = HttpReplayServer.start(goldenPath, false, options.port() != null ? options.port() : 0, capturePath);
        } catch (IOException e) {
            return Result.harnessFailure(ReasonCode.SERVER_START_FAILED, "Replay server failed to start: " + e.getMessage());
        }

        Lifecycle.AgentRunResult agentResult;
        try {
            agentResult = Lifecycle.runAgent(command, "http://127.0.0.1:" + server.port(), options.timeoutMs());
        } catch (IOException e) {
            closeQuietly(server); // a close failure here shouldn't mask the more specific spawn failure
            deleteQuietly(capturePath);
            return Result.harnessFailure(ReasonCode.SPAWN_FAILED, "Failed to spawn agent command: " + e.getMessage());
        }

        // Every exit path from here closes the listener and flushes the capture -- but the
        // close itself can throw (e.g. the capture tee's flush fails), so it's caught here
        // rather than left to propagate uncaught past the cleanup below.
        try {
            server.close();
        } catch (RuntimeException e) {
            deleteQuietly(capturePath);
            return Result.harnessFailure(ReasonCode.CLEANUP_FAILED, "Failed to close replay server: " + e.getMessage());
        }

        try {
            if (agentResult.timedOut()) {
                return Result.harnessFailure(ReasonCode.TIMEOUT, "Agent timed out after " + options.timeoutMs() + "ms; capture may be incomplete.");
            }
            if (agentResult.exitCode() != 0) {
                return Result.harnessFailure(ReasonCode.AGENT_EXIT_NONZERO, "Agent exited with code " + agentResult.exitCode() + ".");
            }

            CassetteContents actual;
            try {
                actual = new CassetteReader(capturePath).loadAll();
            } catch (RuntimeException e) {
                return Result.harnessFailure(ReasonCode.CAPTURE_READ_FAILED, "No usable capture: " + e.getMessage());
            }

            if (actual.frames().isEmpty()) {
                return Result.harnessFailure(ReasonCode.NO_CAPTURE, "No frames captured -- the agent never connected to DEJA_MCP_URL.");
            }

            TrajectoryReport report = Compare.compareCassetteFrames(golden.frames(), actual.frames(), options.compareOptions());

            boolean updated = false;
            if (options.update() && (report.session() == null || report.session().replayMisses() == 0)) {
                try {
                    promoteCapture(goldenPath, golden.header(), capturePath);
                    updated = true;
                } catch (RuntimeException e) {
                    return Result.harnessFailure(ReasonCode.UPDATE_WRITE_FAILED, "Failed to update golden cassette: " + e.getMessage());
                }
            }

            return new Result(report.summary().passed() ? 0 : 1, report, null, null, updated);
        } finally {
            deleteQuietly(capturePath);
        }
    }

    /** Rewrite that preserves the golden's own provenance fields ({@code serverCommand}/{@code
     *  target} describe the *original* upstream, still meaningful context even though this
     *  promoted cassette was captured via replay-and-tee rather than a live recording) while
     *  stamping a fresh {@code recordedAt}. The capture is already redacted by the capture tee
     *  itself. Package-private, not private -- so {@code RunGateTest} can exercise its failure
     *  path directly (a nonexistent target directory), independent of {@link #run}. */
    static void promoteCapture(Path goldenPath, CassetteHeader oldHeader, Path capturePath) {
        CassetteContents captured = new CassetteReader(capturePath).loadAll();
        try (CassetteWriter writer = new CassetteWriter(goldenPath)) {
            writer.write(CassetteHeader.of(Instant.now().toString(), TransportType.HTTP, oldHeader.serverCommand(), oldHeader.target()));
            for (CassetteFrame frame : captured.frames()) {
                writer.write(frame);
            }
        }
    }

    private static void closeQuietly(HttpReplayServer server) {
        try {
            server.close();
        } catch (RuntimeException ignored) {
            // Best-effort close on a path that already has a more specific failure to report.
        }
    }

    private static void deleteQuietly(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (IOException ignored) {
            // Best-effort cleanup of a temp file -- not worth failing the gate run over.
        }
    }
}
