package dev.deja.core.trajectory;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum TrajectoryMode {
    STRICT("strict"),
    UNORDERED("unordered"),
    SUBSET("subset"),
    SUPERSET("superset"),
    POLICY("policy");

    private final String wireValue;

    TrajectoryMode(String wireValue) {
        this.wireValue = wireValue;
    }

    @JsonValue
    public String wireValue() {
        return wireValue;
    }

    @JsonCreator
    public static TrajectoryMode fromWireValue(String wireValue) {
        for (TrajectoryMode mode : values()) {
            if (mode.wireValue.equals(wireValue)) {
                return mode;
            }
        }
        throw new IllegalArgumentException("Unknown trajectory mode: " + wireValue);
    }
}
