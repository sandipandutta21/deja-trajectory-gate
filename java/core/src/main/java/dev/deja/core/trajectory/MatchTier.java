package dev.deja.core.trajectory;

import com.fasterxml.jackson.annotation.JsonValue;

/** Which tier of {@link dev.deja.core.match.Match} produced a pair's score. Mirrors the
 *  TypeScript implementation's {@code MatchingTier}, restricted to the two values the
 *  trajectory comparison engine actually produces. */
public enum MatchTier {
    EXACT("exact"),
    SEMANTIC("semantic");

    private final String wireValue;

    MatchTier(String wireValue) {
        this.wireValue = wireValue;
    }

    @JsonValue
    public String wireValue() {
        return wireValue;
    }
}
