package dev.deja.core.trajectory;

import dev.deja.core.json.Canon;
import lombok.experimental.UtilityClass;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/** Mirrors the TypeScript implementation's {@code policy.ts}. */
@UtilityClass
public class Policy {

    private boolean sameMethodAndTool(PolicyStepMatcher matcher, TrajectoryStep step) {
        if (!matcher.method().equals(step.method())) {
            return false;
        }
        return matcher.toolName() == null || matcher.toolName().equals(step.toolName());
    }

    /** Every key in {@code argsMatch} must deep-equal the step's corresponding param; extra
     *  params on the step that {@code argsMatch} doesn't mention are ignored -- a predicate,
     *  not a whole-object similarity score. */
    private boolean matchesArgsPredicate(Map<String, Object> params, Map<String, Object> argsMatch) {
        if (argsMatch == null || argsMatch.isEmpty()) {
            return true;
        }
        if (params == null) {
            return false;
        }
        for (Map.Entry<String, Object> entry : argsMatch.entrySet()) {
            if (!Objects.equals(Canon.stableStringify(params.get(entry.getKey())), Canon.stableStringify(entry.getValue()))) {
                return false;
            }
        }
        return true;
    }

    private boolean matchesMatcher(PolicyStepMatcher matcher, TrajectoryStep step) {
        return sameMethodAndTool(matcher, step) && matchesArgsPredicate(step.params(), matcher.argsMatch());
    }

    /** First actual step (in trajectory order) satisfying {@code matcher}, if any. */
    public Optional<TrajectoryStep> findPolicyMatch(PolicyStepMatcher matcher, List<TrajectoryStep> actual) {
        return actual.stream().filter(step -> matchesMatcher(matcher, step)).findFirst();
    }

    /** Every actual step satisfying {@code matcher} -- used for {@code prohibited}, where any
     *  presence counts. */
    public List<TrajectoryStep> findAllPolicyMatches(PolicyStepMatcher matcher, List<TrajectoryStep> actual) {
        return actual.stream().filter(step -> matchesMatcher(matcher, step)).toList();
    }

    /** True when some matcher in {@code matchers} covers {@code step} -- used to find
     *  untracked steps under {@code closedWorld}. */
    public boolean isCoveredByAnyMatcher(TrajectoryStep step, List<PolicyStepMatcher> matchers) {
        return matchers.stream().anyMatch(matcher -> matchesMatcher(matcher, step));
    }

    /**
     * Seeds a starting {@link TrajectoryPolicy} from a golden trajectory: every
     * golden step becomes a {@code required} matcher with a full {@code argsMatch} (its
     * complete params), nothing is {@code prohibited}, {@code closedWorld} defaults to {@code
     * false}. A human edits it from there rather than deja guessing intent.
     */
    public TrajectoryPolicy derivePolicy(List<TrajectoryStep> golden) {
        List<PolicyStepMatcher> required = golden.stream()
                .map(step -> new PolicyStepMatcher(step.method(), step.toolName(), step.params()))
                .toList();
        return new TrajectoryPolicy(TrajectoryPolicy.CURRENT_VERSION, required, List.of(), List.of(), false);
    }
}
