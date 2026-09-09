package dev.deja.junit5;

import org.junit.jupiter.api.extension.ExtendWith;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Injects an {@link McpSession} test parameter backed by a cassette. In replay mode (the
 * default), every request is answered from the cassette with zero subprocess and zero
 * network access, so the suite is fast and deterministic in CI. Setting the {@code
 * DEJA_MODE=record} environment variable (or system property) re-records the identical test
 * code against {@link #record()} instead, refreshing the cassette without touching a single
 * assertion.
 *
 * <p>Class-level only (not method-level): record mode spawns one server process and records
 * every test method in the class into one cassette as a single continuous session, matching
 * how the recording is actually structured on disk. Missed-request tracking in replay mode is
 * still isolated per test method, so one test's mismatch is reported against that test alone.
 */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
@ExtendWith(CassetteExtension.class)
public @interface Cassette {

    /** Path to the cassette file, relative to the working directory. */
    String value();

    /** The command to spawn when {@code DEJA_MODE=record} is set. Each element may contain
     *  {@code ${env:VAR}} or {@code ${sys:property}} placeholders, interpolated at runtime --
     *  e.g. {@code {"java", "-jar", "${sys:server.jar.path}"}}. Required for record mode;
     *  ignored entirely in replay mode. */
    String[] record() default {};

    /** Whether replay falls back to the semantic matching tier for a request with no exact
     *  structural match. Has no effect in record mode. */
    boolean semantic() default false;

    /** Skips redaction when recording. Has no effect in replay mode. */
    boolean noRedact() default false;

    /**
     * Trajectory Gate mode: instead of failing only on an unmatched request,
     * captures every request/response exchanged during each test method and, in {@link
     * #afterEach}, compares the resulting trajectory against {@link #value()} in {@code
     * strict} mode -- failing the test with a full human-readable report on any divergence,
     * not just a replay miss. Requires replay mode (no {@code DEJA_MODE=record}): gate
     * compares against a golden, it doesn't produce one.
     */
    boolean gate() default false;
}
