package dev.deja.cli;

import com.fasterxml.jackson.databind.JsonNode;
import dev.deja.core.cassette.CassetteFrame;
import dev.deja.core.cassette.CassetteHeader;
import dev.deja.core.cassette.CassetteWriter;
import dev.deja.core.cassette.Direction;
import dev.deja.core.cassette.JsonRpcMessage;
import dev.deja.core.cassette.TransportType;
import dev.deja.core.json.Json;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Exercises {@code Main} itself as a real subprocess (not {@code RunGate} directly) -- the
 * {@code --json} harness-failure wrapping this covers lives in {@code Main.runGateCommand},
 * one layer above {@code RunGate.run}.
 */
class MainGateJsonTest {

    @TempDir
    Path tempDir;

    private static List<String> javaCommand(String mainClass, String... args) {
        String javaBin = ProcessHandle.current().info().command().orElseThrow();
        String classpath = System.getProperty("java.class.path");
        List<String> command = new java.util.ArrayList<>(List.of(javaBin, "-cp", classpath, mainClass));
        command.addAll(List.of(args));
        return command;
    }

    private Path writeGolden() {
        Path path = tempDir.resolve("golden.jsonl");
        try (CassetteWriter writer = new CassetteWriter(path)) {
            writer.write(CassetteHeader.of(Instant.now().toString(), TransportType.HTTP, null, null));
            writer.write(CassetteFrame.of(Direction.C2S, 0, JsonRpcMessage.request(1, "tools/list", null)));
            writer.write(CassetteFrame.of(Direction.S2C, 1, JsonRpcMessage.result(1, Map.of("tools", List.of()))));
        }
        return path;
    }

    @Test
    @Timeout(30)
    void emitsAStructuredErrorObjectOnAHarnessFailureInsteadOfSilentlyDroppingJson() throws Exception {
        Path golden = writeGolden();

        List<String> command = new java.util.ArrayList<>(javaCommand("dev.deja.cli.Main", "gate", golden.toString(), "--json"));
        command.add("--");
        command.addAll(javaCommand("dev.deja.cli.FixtureAgentMain", "failing"));

        Process process = new ProcessBuilder(command).redirectErrorStream(false).start();
        String stdout;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            stdout = reader.lines().reduce("", (a, b) -> a + b);
        }
        int exitCode = process.waitFor();

        assertThat(exitCode).isEqualTo(3);
        JsonNode node = Json.MAPPER.readTree(stdout);
        assertThat(node.get("verdict").asText()).isEqualTo("error");
        assertThat(node.get("reasonCode").asText()).isEqualTo("agent-exit-nonzero");
        assertThat(node.get("reason").asText()).contains("exited with code 7");
        assertThat(node.get("exitCode").asInt()).isEqualTo(3);
    }

    @Test
    @Timeout(30)
    void validatesModeBeforeSpawningTheAgent() throws Exception {
        Path golden = writeGolden();
        // An agent command that's guaranteed to fail to spawn: if validation happened *after*
        // attempting to spawn it, this would exit 3 (harness failure) instead of 2.
        List<String> command = new java.util.ArrayList<>(javaCommand("dev.deja.cli.Main", "gate", golden.toString(), "--mode", "bogus-mode"));
        command.add("--");
        command.add("definitely-not-a-real-binary-xyz");

        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        int exitCode = process.waitFor();

        assertThat(exitCode).isEqualTo(2);
    }

    @Test
    @Timeout(30)
    void terminatingDejaGateForwardsToTheAgentInsteadOfOrphaningIt() throws Exception {
        Path golden = writeGolden();

        List<String> command = new java.util.ArrayList<>(javaCommand("dev.deja.cli.Main", "gate", golden.toString()));
        command.add("--");
        command.addAll(javaCommand("dev.deja.cli.FixtureAgentMain", "hanging"));

        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        // Poll rather than a single fixed sleep -- a shared/slower CI runner can easily take
        // longer than a local dev machine to start the JVM, bind the replay server, and spawn
        // the agent; a one-shot sleep that happens to be long enough locally is exactly the
        // kind of thing that's flaky in CI, not a fixed amount of extra safety margin.
        ProcessHandle agentHandle = pollUntilPresent(() -> process.toHandle().descendants().findFirst(), java.time.Duration.ofSeconds(15));

        process.destroy(); // SIGTERM-equivalent -- triggers Lifecycle's shutdown hook
        assertThat(process.waitFor(15, java.util.concurrent.TimeUnit.SECONDS)).isTrue();

        pollUntilTrue(() -> !agentHandle.isAlive(), java.time.Duration.ofSeconds(10));
    }

    private static <T> T pollUntilPresent(java.util.function.Supplier<java.util.Optional<T>> probe, java.time.Duration timeout) throws InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            java.util.Optional<T> result = probe.get();
            if (result.isPresent()) {
                return result.get();
            }
            Thread.sleep(50);
        }
        throw new AssertionError("Condition never became true within " + timeout);
    }

    private static void pollUntilTrue(java.util.function.BooleanSupplier condition, java.time.Duration timeout) throws InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("Condition never became true within " + timeout);
    }
}
