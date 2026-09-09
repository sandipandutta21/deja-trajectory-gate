package dev.deja.core;

import com.fasterxml.jackson.databind.JsonNode;
import dev.deja.core.cassette.CassetteContents;
import dev.deja.core.cassette.CassetteReader;
import dev.deja.core.json.Json;
import dev.deja.core.trajectory.Compare;
import dev.deja.core.trajectory.CompareOptions;
import dev.deja.core.trajectory.Report;
import dev.deja.core.trajectory.TrajectoryMode;
import dev.deja.core.trajectory.TrajectoryReport;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.DynamicTest.dynamicTest;

/**
 * Cross-language conformance for Trajectory Gate: the ten golden/actual vectors
 * under {@code conformance/trajectory/} (a sibling of both {@code ts/} and {@code java/}) were
 * generated once by the TypeScript implementation ({@code
 * ts/scripts/generate-trajectory-conformance.mjs}) and committed as {@code
 * expected-report.json}. This test runs the exact same fixtures through the Java port and
 * asserts the canonical JSON matches byte-for-byte (compared as parsed trees, so key order
 * matters but incidental whitespace differences in how the JSON was pretty-printed don't) --
 * proof the two implementations agree on trajectory extraction, alignment, and policy
 * evaluation, not just that each one's own test suite is internally consistent.
 */
class TrajectoryConformanceTest {

    private static final Path CONFORMANCE_DIR = Path.of("../../conformance/trajectory");

    @TestFactory
    Stream<DynamicTest> matchesTheFrozenExpectedReport() throws IOException {
        try (Stream<Path> entries = Files.list(CONFORMANCE_DIR)) {
            List<Path> vectors = entries.filter(Files::isDirectory).sorted().toList();
            assertThat(vectors).hasSize(10);

            return vectors.stream().map(dir -> dynamicTest(dir.getFileName().toString(), () -> runVector(dir)));
        }
    }

    private void runVector(Path dir) throws IOException {
        JsonNode caseOptions = Json.MAPPER.readTree(dir.resolve("case.json").toFile());
        CompareOptions options = CompareOptions.builder()
                .mode(caseOptions.has("mode") ? TrajectoryMode.fromWireValue(caseOptions.get("mode").asText()) : null)
                .threshold(caseOptions.has("threshold") ? caseOptions.get("threshold").asDouble() : null)
                .build();

        CassetteContents golden = new CassetteReader(dir.resolve("golden.jsonl")).loadAll();
        CassetteContents actual = new CassetteReader(dir.resolve("actual.jsonl")).loadAll();

        TrajectoryReport report = Compare.compareCassetteFrames(golden.frames(), actual.frames(), options);
        JsonNode actualJson = Report.toCanonicalReport(report);
        JsonNode expectedJson = readExpected(dir);

        assertThat(actualJson).as("vector: %s", dir.getFileName()).isEqualTo(expectedJson);
    }

    private JsonNode readExpected(Path dir) {
        try {
            return Json.MAPPER.readTree(dir.resolve("expected-report.json").toFile());
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
