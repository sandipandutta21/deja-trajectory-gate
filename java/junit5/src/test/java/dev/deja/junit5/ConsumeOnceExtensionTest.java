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
 * Drives {@code @Cassette(consumeOnce = true)} through JUnit's real launcher, the same way
 * {@link CassetteExtensionFailureTest} verifies plain replay-mode failures and {@link
 * GateExtensionTest} verifies gate mode. {@code gate-session.jsonl} has exactly one recorded
 * {@code tools/list} interaction (see {@link GateExtensionTest}'s own subjects), which is what
 * lets a duplicate call within one test method be the thing under test here.
 *
 * <p>Subjects are deliberately named without a "Test" suffix so Gradle's own test discovery
 * doesn't also try to run them directly as top-level test classes.
 */
class ConsumeOnceExtensionTest {

    @Cassette(value = "src/test/resources/fixtures/gate-session.jsonl", consumeOnce = true)
    static class ConsumeOnceSubject {
        @Test
        void singleCallSucceeds(McpSession session) {
            session.request("tools/list", null);
        }

        @Test
        void duplicateCallFailsOnItsSecondOccurrence(McpSession session) {
            session.request("tools/list", null);
            session.request("tools/list", null);
        }
    }

    @Test
    void singleCallStillPasses() {
        EngineTestKit.engine("junit-jupiter")
                .selectors(selectClass(ConsumeOnceSubject.class))
                .execute()
                .testEvents()
                .assertThatEvents()
                .haveExactly(1, event(test("singleCallSucceeds"), finishedSuccessfully()));
    }

    @Test
    void secondIdenticalCallMissesOnceTheOneRecordedInteractionIsConsumed() {
        EngineTestKit.engine("junit-jupiter")
                .selectors(selectClass(ConsumeOnceSubject.class))
                .execute()
                .testEvents()
                .assertThatEvents()
                .haveExactly(1, event(
                        test("duplicateCallFailsOnItsSecondOccurrence"),
                        finishedWithFailure(instanceOf(McpSessionException.class), message(m -> m.contains("-32603")))));
    }
}
