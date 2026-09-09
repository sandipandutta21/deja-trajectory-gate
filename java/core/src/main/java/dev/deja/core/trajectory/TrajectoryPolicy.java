package dev.deja.core.trajectory;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * An explicit required/prohibited/optional behavior policy, the reference
 * document for {@code policy} mode instead of a golden trajectory.
 *
 * @param closedWorld steps matched by none of required/prohibited/optional are treated as
 *                    prohibited when {@code true}. Default {@code false}.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonIgnoreProperties(ignoreUnknown = true)
public record TrajectoryPolicy(
        @JsonProperty("policyVersion") int policyVersion,
        @JsonProperty("required") List<PolicyStepMatcher> required,
        @JsonProperty("prohibited") List<PolicyStepMatcher> prohibited,
        @JsonProperty("optional") List<PolicyStepMatcher> optional,
        @JsonProperty("closedWorld") boolean closedWorld) {

    public static final int CURRENT_VERSION = 1;

    /** Normalizes absent lists to empty rather than null, so every consumer of this record can
     *  iterate {@code required()}/{@code prohibited()}/{@code optional()} unconditionally. */
    public TrajectoryPolicy {
        required = required != null ? required : List.of();
        prohibited = prohibited != null ? prohibited : List.of();
        optional = optional != null ? optional : List.of();
    }
}
