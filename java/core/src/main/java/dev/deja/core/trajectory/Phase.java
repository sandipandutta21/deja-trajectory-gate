package dev.deja.core.trajectory;

import com.fasterxml.jackson.annotation.JsonValue;

/** Only ever {@link #POST_DIVERGENCE}; pre-divergence is the implicit default and is
 *  represented as a {@code null} phase field, omitted from the canonical report. */
public enum Phase {
    POST_DIVERGENCE("post-divergence");

    private final String wireValue;

    Phase(String wireValue) {
        this.wireValue = wireValue;
    }

    @JsonValue
    public String wireValue() {
        return wireValue;
    }
}
