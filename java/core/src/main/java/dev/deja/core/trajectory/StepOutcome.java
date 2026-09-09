package dev.deja.core.trajectory;

import com.fasterxml.jackson.annotation.JsonValue;

public enum StepOutcome {
    EXACT("exact"),
    TOLERATED("tolerated"),
    DRIFTED("drifted"),
    /** A diagnostic-only relabeling of an otherwise-equivalent missing+added pair -- still a
     *  failure in strict mode, never changes what passes or fails. */
    REORDERED("reordered"),
    ADDED("added"),
    MISSING("missing"),
    REQUIRED_SATISFIED("required-satisfied"),
    REQUIRED_MISSING("required-missing"),
    PROHIBITED_PRESENT("prohibited-present"),
    OPTIONAL_OBSERVED("optional-observed"),
    OPTIONAL_ABSENT("optional-absent");

    private final String wireValue;

    StepOutcome(String wireValue) {
        this.wireValue = wireValue;
    }

    @JsonValue
    public String wireValue() {
        return wireValue;
    }
}
