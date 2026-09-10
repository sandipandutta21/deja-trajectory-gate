package dev.deja.core;

import dev.deja.core.cassette.CassetteContents;
import dev.deja.core.cassette.CassetteFrame;
import dev.deja.core.cassette.CassetteReader;
import dev.deja.core.cassette.Direction;
import dev.deja.core.cassette.JsonRpcMessage;
import dev.deja.core.cassette.TransportType;
import dev.deja.core.fixtures.EchoServerFixture;
import dev.deja.core.fixtures.NotifyingEchoServerFixture;
import dev.deja.core.recorder.ProcessRecorder;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ProcessRecorderTest {

    /** The current test JVM's own classpath, so the spawned child JVM can find both the
     *  fixture class and Jackson -- a real subprocess, not an in-process fake. */
    private List<String> serverCommand(Class<?> fixtureMainClass) {
        String javaBin = System.getProperty("java.home") + File.separator + "bin" + File.separator + "java";
        String classpath = System.getProperty("java.class.path");
        return List.of(javaBin, "-cp", classpath, fixtureMainClass.getName());
    }

    private List<String> echoServerCommand() {
        return serverCommand(EchoServerFixture.class);
    }

    @Test
    void sendNotificationRecordsItWithoutWaitingForAResponse(@TempDir Path tempDir) {
        Path cassettePath = tempDir.resolve("notification.jsonl");

        try (ProcessRecorder recorder = new ProcessRecorder(echoServerCommand(), cassettePath, true)) {
            recorder.sendNotification("notifications/initialized", null);
        }

        CassetteContents contents = new CassetteReader(cassettePath).loadAll();
        assertThat(contents.frames()).anySatisfy(frame -> {
            assertThat(frame.dir()).isEqualTo(Direction.C2S);
            assertThat(frame.msg().method()).isEqualTo("notifications/initialized");
            assertThat(frame.msg().id()).isNull();
        });
    }

    @Test
    void recordsARequestResponseRoundTripToTheCassette(@TempDir Path tempDir) {
        Path cassettePath = tempDir.resolve("recorded.jsonl");

        try (ProcessRecorder recorder = new ProcessRecorder(echoServerCommand(), cassettePath, true)) {
            JsonRpcMessage response = recorder.send("tools/list", null);
            assertThat(response.result()).isNotNull();
        }

        CassetteContents contents = new CassetteReader(cassettePath).loadAll();
        assertThat(contents.header().transport()).isEqualTo(TransportType.STDIO);
        assertThat(contents.frames()).hasSize(2);
        assertThat(contents.frames().get(0).dir()).isEqualTo(Direction.C2S);
        assertThat(contents.frames().get(0).msg().method()).isEqualTo("tools/list");
        assertThat(contents.frames().get(1).dir()).isEqualTo(Direction.S2C);
    }

    @Test
    @SuppressWarnings("unchecked")
    void redactsASecretEmbeddedInTheLiveRoundTripWithoutAlteringWhatTheCallerSaw(@TempDir Path tempDir) throws java.io.IOException {
        Path cassettePath = tempDir.resolve("redacted.jsonl");
        String secret = "sk-abc123def456ghi789jkl012mno345pqr678stu901";

        try (ProcessRecorder recorder = new ProcessRecorder(echoServerCommand(), cassettePath, true)) {
            JsonRpcMessage response = recorder.send("echo", Map.of("message", "my key is " + secret));
            Map<String, Object> result = (Map<String, Object>) response.result();
            // The live caller still sees the real secret -- only the cassette is redacted.
            assertThat((String) result.get("message")).contains(secret);
        }

        CassetteContents contents = new CassetteReader(cassettePath).loadAll();
        Map<String, Object> recordedParams = contents.frames().get(0).msg().params();
        assertThat((String) recordedParams.get("message")).doesNotContain(secret);
        assertThat((String) recordedParams.get("message")).matches(".*\\[REDACTED:sk:[a-f0-9]{8}].*");

        // Stronger than "the parsed field doesn't contain it": the literal secret string is
        // provably absent from the file's raw bytes, not just from the field we happened to check.
        String rawFileContents = java.nio.file.Files.readString(cassettePath);
        assertThat(rawFileContents).doesNotContain(secret);
    }

    @Test
    void preservesTheRawSecretWhenRedactIsDisabled(@TempDir Path tempDir) {
        Path cassettePath = tempDir.resolve("no-redact.jsonl");
        String secret = "sk-abc123def456ghi789jkl012mno345pqr678stu901";

        try (ProcessRecorder recorder = new ProcessRecorder(echoServerCommand(), cassettePath, false)) {
            recorder.send("echo", Map.of("message", secret));
        }

        CassetteContents contents = new CassetteReader(cassettePath).loadAll();
        Map<String, Object> recordedParams = contents.frames().get(0).msg().params();
        assertThat((String) recordedParams.get("message")).isEqualTo(secret);
    }

    @Test
    void correctlyDemuxesAnUnsolicitedNotificationInterleavedBeforeTheActualResponse(@TempDir Path tempDir) {
        // Regression test: a naive "read exactly one line after writing one" implementation
        // would misread the server's unsolicited notification as the response to our request
        // (this is the same class of bug found and fixed in the TypeScript implementation's
        // verify.ts, against the real MCP "Everything" reference server).
        Path cassettePath = tempDir.resolve("notifying.jsonl");

        try (ProcessRecorder recorder = new ProcessRecorder(serverCommand(NotifyingEchoServerFixture.class), cassettePath, true)) {
            JsonRpcMessage response = recorder.send("tools/list", null);
            assertThat(response.error()).isNull();
            assertThat(response.result()).isNotNull();
        }

        CassetteContents contents = new CassetteReader(cassettePath).loadAll();
        assertThat(contents.frames()).hasSize(3);

        // The unsolicited notification was recorded in its own right, not swallowed as if it
        // were the response.
        assertThat(contents.frames()).anySatisfy(frame -> {
            assertThat(frame.dir()).isEqualTo(Direction.S2C);
            assertThat(frame.msg().method()).isEqualTo("notifications/unsolicited");
            assertThat(frame.msg().id()).isNull();
        });

        // And the real response still correctly correlates back to our request's id.
        CassetteFrame requestFrame = contents.frames().stream().filter(f -> f.dir() == Direction.C2S).findFirst().orElseThrow();
        CassetteFrame responseFrame = contents.frames().stream()
                .filter(f -> f.dir() == Direction.S2C && f.msg().id() != null)
                .findFirst()
                .orElseThrow();
        assertThat(responseFrame.msg().id()).isEqualTo(requestFrame.msg().id());
    }
}
