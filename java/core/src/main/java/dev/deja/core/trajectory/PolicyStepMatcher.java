package dev.deja.core.trajectory;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Map;

/**
 * One required/prohibited/optional step matcher inside a {@link TrajectoryPolicy}.
 *
 * @param method    JSON-RPC/MCP method to match
 * @param toolName  present only to further restrict a {@code tools/call} matcher
 * @param argsMatch exact per-key structural predicate over the step's params -- every listed
 *                  key must deep-equal, extra params on the step are ignored. Not a fuzzy
 *                  similarity score: a partial key/value predicate has no well-defined
 *                  "similarity" against an object that may legitimately contain additional
 *                  untested fields.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonIgnoreProperties(ignoreUnknown = true)
public record PolicyStepMatcher(
        @JsonProperty("method") String method,
        @JsonProperty("toolName") String toolName,
        @JsonProperty("argsMatch") Map<String, Object> argsMatch) {
}
