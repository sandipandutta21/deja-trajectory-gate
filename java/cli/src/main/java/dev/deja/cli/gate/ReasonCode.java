package dev.deja.cli.gate;

import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Stable, machine-checkable identifier for *why* a harness failure happened -- so a CI consumer
 * can branch on this instead of substring-matching {@link RunGate.Result#reason()}'s free text,
 * the same anti-pattern the no-match sentinel's error code already fixed on the replay side.
 * Mirrors the TypeScript implementation's {@code GateFailureReasonCode}. One value per failure
 * site in {@link RunGate#run}.
 */
public enum ReasonCode {
    GOLDEN_READ_FAILED("golden-read-failed"),
    SERVER_START_FAILED("server-start-failed"),
    SPAWN_FAILED("spawn-failed"),
    TIMEOUT("timeout"),
    AGENT_EXIT_NONZERO("agent-exit-nonzero"),
    CAPTURE_READ_FAILED("capture-read-failed"),
    NO_CAPTURE("no-capture"),
    UPDATE_WRITE_FAILED("update-write-failed"),
    CLEANUP_FAILED("cleanup-failed");

    private final String wireValue;

    ReasonCode(String wireValue) {
        this.wireValue = wireValue;
    }

    @JsonValue
    public String wireValue() {
        return wireValue;
    }
}
