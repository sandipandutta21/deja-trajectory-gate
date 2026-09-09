package dev.deja.junit5;

import org.junit.jupiter.api.Test;
import org.junit.platform.testkit.engine.EngineTestKit;

import static org.junit.platform.engine.discovery.DiscoverySelectors.selectClass;
import static org.junit.platform.testkit.engine.EventConditions.event;
import static org.junit.platform.testkit.engine.EventConditions.finishedSuccessfully;
import static org.junit.platform.testkit.engine.EventConditions.finishedWithFailure;
import static org.junit.platform.testkit.engine.EventConditions.test;
import static org.junit.platform.testkit.engine.TestExecutionResultConditions.instanceOf;
import static org.junit.platform.testkit.engine.TestExecutionResultConditions.message;

/**
 * Drives {@code @Cassette(gate = true)} through JUnit's real launcher (via {@code
 * junit-platform-testkit}), the same way {@link CassetteExtensionFailureTest} verifies plain
 * replay-mode failures. The subjects are deliberately named without a "Test" suffix so
 * Gradle's own test discovery doesn't also try to run them directly as top-level test classes.
 */
class GateExtensionTest {

    @Cassette(value = "src/test/resources/fixtures/gate-session.jsonl", gate = true)
    static class GateMatchingSubject {
        @Test
        void matchesGoldenExactly(McpSession session) {
            session.request("tools/list", null);
        }
    }

    @Cassette(value = "src/test/resources/fixtures/gate-session.jsonl", gate = true)
    static class GateDivergentSubject {
        @Test
        void callsAnExtraTimeBeyondGolden(McpSession session) {
            // Both calls succeed individually (ReplayEngine's structural match is stateless,
            // not "consume once") -- only the gate's trajectory comparison, at afterEach,
            // catches that this is one call more than the golden ever recorded.
            session.request("tools/list", null);
            session.request("tools/list", null);
        }
    }

    @Test
    void passesWhenTheCapturedTrajectoryMatchesTheGoldenExactly() {
        EngineTestKit.engine("junit-jupiter")
                .selectors(selectClass(GateMatchingSubject.class))
                .execute()
                .testEvents()
                .assertThatEvents()
                .haveExactly(1, event(test("matchesGoldenExactly"), finishedSuccessfully()));
    }

    @Test
    void failsWithAFullReportWhenTheCapturedTrajectoryDivergesFromTheGolden() {
        EngineTestKit.engine("junit-jupiter")
                .selectors(selectClass(GateDivergentSubject.class))
                .execute()
                .testEvents()
                .assertThatEvents()
                .haveExactly(1, event(
                        test("callsAnExtraTimeBeyondGolden"),
                        finishedWithFailure(instanceOf(AssertionError.class), message(m -> m.contains("FAIL") && m.contains("added")))));
    }
}
