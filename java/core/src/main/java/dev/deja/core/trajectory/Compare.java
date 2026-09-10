package dev.deja.core.trajectory;

import dev.deja.core.cassette.CassetteFrame;
import dev.deja.core.trajectory.Alignment.AlignedPair;
import dev.deja.core.trajectory.Frontier.TrajectorySession;
import lombok.experimental.UtilityClass;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/** Mirrors the TypeScript implementation's {@code compare.ts}. */
@UtilityClass
public class Compare {

    /** A step is "post-divergence" only once we know an earlier actual request went unserved --
     *  derived from {@link Frontier#detectReplaySession}, never asserted for golden-only
     *  entries. */
    private Phase phaseFor(TrajectoryStep step, TrajectorySession session) {
        if (step == null || session == null || session.firstMissFrameIndex() == null) {
            return null;
        }
        return step.frameIndex() >= session.firstMissFrameIndex() ? Phase.POST_DIVERGENCE : null;
    }

    private final class Counts {
        boolean passed = true;
        int exact;
        int tolerated;
        int drifted;
        int reordered;
        int added;
        int missing;
        int requiredMissing;
        int prohibitedPresent;

        TrajectorySummary toSummary() {
            return new TrajectorySummary(passed, exact, tolerated, drifted, reordered, added, missing, requiredMissing, prohibitedPresent);
        }
    }

    private TrajectoryStepReport classifySequencePair(
            AlignedPair pair, List<TrajectoryStep> golden, List<TrajectoryStep> actual, double threshold, TrajectorySession session) {
        TrajectoryStep goldenStep = pair.goldenIndex() != null ? golden.get(pair.goldenIndex()) : null;
        TrajectoryStep actualStep = pair.actualIndex() != null ? actual.get(pair.actualIndex()) : null;
        TrajectoryStep step = goldenStep != null ? goldenStep : actualStep;

        StepOutcome outcome;
        if (goldenStep != null && actualStep != null) {
            outcome = pair.reordered()
                    ? StepOutcome.REORDERED
                    : pair.score() != null && pair.score() == 1
                            ? StepOutcome.EXACT
                            : (pair.score() != null ? pair.score() : 0) >= threshold ? StepOutcome.TOLERATED : StepOutcome.DRIFTED;
        } else {
            outcome = goldenStep != null ? StepOutcome.MISSING : StepOutcome.ADDED;
        }

        return new TrajectoryStepReport(
                goldenStep != null ? goldenStep.index() : null,
                actualStep != null ? actualStep.index() : null,
                outcome,
                step.method(),
                step.toolName(),
                pair.score(),
                pair.tier(),
                phaseFor(actualStep, session));
    }

    /** {@code drifted} always fails; whether an unmatched side fails depends on mode (subset
     *  tolerates unmatched golden, superset tolerates unmatched actual, strict/unordered
     *  tolerate neither). */
    private boolean isSequenceFailure(StepOutcome outcome, TrajectoryMode mode) {
        // Still a failure: the label improves diagnosis only, it never changes gate semantics.
        // annotateReorders only ever fires in strict mode, where this was already going to
        // fail as disconnected missing/added entries.
        if (outcome == StepOutcome.DRIFTED || outcome == StepOutcome.REORDERED) {
            return true;
        }
        if (outcome == StepOutcome.MISSING) {
            return mode != TrajectoryMode.SUBSET;
        }
        if (outcome == StepOutcome.ADDED) {
            return mode != TrajectoryMode.SUPERSET;
        }
        return false;
    }

    private TrajectoryReport buildSequenceReport(
            TrajectoryMode mode, double threshold, List<TrajectoryStep> golden, List<TrajectoryStep> actual,
            List<AlignedPair> pairs, TrajectorySession session) {
        Counts counts = new Counts();
        List<TrajectoryStepReport> steps = new ArrayList<>();

        for (AlignedPair pair : pairs) {
            TrajectoryStepReport report = classifySequencePair(pair, golden, actual, threshold, session);
            switch (report.outcome()) {
                case EXACT -> counts.exact++;
                case TOLERATED -> counts.tolerated++;
                case DRIFTED -> counts.drifted++;
                case REORDERED -> counts.reordered++;
                case MISSING -> counts.missing++;
                case ADDED -> counts.added++;
                default -> { }
            }
            if (isSequenceFailure(report.outcome(), mode)) {
                counts.passed = false;
            }
            steps.add(report);
        }

        return new TrajectoryReport(TrajectoryReport.CURRENT_VERSION, mode, threshold, steps, session, counts.toSummary());
    }

    private TrajectoryReport evaluatePolicy(List<TrajectoryStep> actual, TrajectoryPolicy policy, TrajectorySession session) {
        Counts counts = new Counts();
        List<TrajectoryStepReport> steps = new ArrayList<>();

        for (PolicyStepMatcher matcher : policy.required()) {
            Optional<TrajectoryStep> found = Policy.findPolicyMatch(matcher, actual);
            if (found.isPresent()) {
                steps.add(new TrajectoryStepReport(
                        null, found.get().index(), StepOutcome.REQUIRED_SATISFIED,
                        matcher.method(), matcher.toolName(), null, null, phaseFor(found.get(), session)));
            } else {
                counts.requiredMissing++;
                counts.passed = false;
                steps.add(new TrajectoryStepReport(null, null, StepOutcome.REQUIRED_MISSING, matcher.method(), matcher.toolName(), null, null, null));
            }
        }

        for (PolicyStepMatcher matcher : policy.prohibited()) {
            for (TrajectoryStep found : Policy.findAllPolicyMatches(matcher, actual)) {
                counts.prohibitedPresent++;
                counts.passed = false;
                steps.add(new TrajectoryStepReport(
                        null, found.index(), StepOutcome.PROHIBITED_PRESENT,
                        matcher.method(), matcher.toolName(), null, null, phaseFor(found, session)));
            }
        }

        for (PolicyStepMatcher matcher : policy.optional()) {
            Optional<TrajectoryStep> found = Policy.findPolicyMatch(matcher, actual);
            if (found.isPresent()) {
                steps.add(new TrajectoryStepReport(
                        null, found.get().index(), StepOutcome.OPTIONAL_OBSERVED,
                        matcher.method(), matcher.toolName(), null, null, phaseFor(found.get(), session)));
            } else {
                steps.add(new TrajectoryStepReport(null, null, StepOutcome.OPTIONAL_ABSENT, matcher.method(), matcher.toolName(), null, null, null));
            }
        }

        if (policy.closedWorld()) {
            List<PolicyStepMatcher> allMatchers = new ArrayList<>();
            allMatchers.addAll(policy.required());
            allMatchers.addAll(policy.prohibited());
            allMatchers.addAll(policy.optional());

            for (TrajectoryStep step : actual) {
                if (Policy.isCoveredByAnyMatcher(step, allMatchers)) {
                    continue;
                }
                counts.prohibitedPresent++;
                counts.passed = false;
                steps.add(new TrajectoryStepReport(
                        null, step.index(), StepOutcome.PROHIBITED_PRESENT,
                        step.method(), step.toolName(), null, null, phaseFor(step, session)));
            }
        }

        return new TrajectoryReport(TrajectoryReport.CURRENT_VERSION, TrajectoryMode.POLICY, CompareOptions.DEFAULT_THRESHOLD, steps, session, counts.toSummary());
    }

    /** Above this, {@code unordered}/{@code subset}/{@code superset} mode's per-group Hungarian
     *  assignment (O(n<sup>3</sup>) in the size of the *largest same-(method,toolName) group*,
     *  not the trajectory as a whole) risks hanging on a pathological input rather than failing
     *  fast. Real trajectories -- an agent's actual tool calls in one run -- are tens to low
     *  hundreds of steps; this is headroom, not a realistic ceiling anyone should ever hit. */
    private static final int MAX_TRAJECTORY_STEPS = 5000;

    private static void checkTrajectorySize(List<TrajectoryStep> golden, List<TrajectoryStep> actual) {
        if (golden.size() > MAX_TRAJECTORY_STEPS || actual.size() > MAX_TRAJECTORY_STEPS) {
            throw new IllegalArgumentException("Deja: trajectory too large to compare (golden " + golden.size()
                    + " steps, actual " + actual.size() + " steps, max " + MAX_TRAJECTORY_STEPS + " per side)");
        }
    }

    /** Compares two already-extracted trajectories. {@code session} -- if the caller has
     *  divergence-frontier evidence (see {@link Frontier#detectReplaySession}) -- tags
     *  post-divergence steps. */
    public TrajectoryReport compareTrajectories(
            List<TrajectoryStep> golden, List<TrajectoryStep> actual, CompareOptions options, TrajectorySession session) {
        checkTrajectorySize(golden, actual);
        TrajectoryMode mode = options.modeOrDefault();
        double threshold = options.thresholdOrDefault();

        if (mode == TrajectoryMode.POLICY) {
            if (options.policy() == null) {
                throw new IllegalArgumentException("policy mode requires a policy document (see --policy / --derive-policy)");
            }
            return evaluatePolicy(actual, options.policy(), session);
        }

        List<AlignedPair> pairs = mode == TrajectoryMode.STRICT
                ? Alignment.annotateReorders(Alignment.alignStrict(golden, actual, threshold), golden, actual, threshold)
                : Alignment.alignUnordered(golden, actual, threshold);
        return buildSequenceReport(mode, threshold, golden, actual, pairs, session);
    }

    public TrajectoryReport compareTrajectories(List<TrajectoryStep> golden, List<TrajectoryStep> actual, CompareOptions options) {
        return compareTrajectories(golden, actual, options, null);
    }

    /** Convenience entry point mirroring the CLI: extracts both trajectories from raw wire
     *  frames and recovers divergence-frontier evidence from the actual cassette itself. */
    public TrajectoryReport compareCassetteFrames(
            List<CassetteFrame> goldenFrames, List<CassetteFrame> actualFrames, CompareOptions options, Set<String> include) {
        List<TrajectoryStep> golden = Extract.extractTrajectory(goldenFrames, include);
        List<TrajectoryStep> actual = Extract.extractTrajectory(actualFrames, include);
        TrajectorySession session = Frontier.detectReplaySession(actualFrames).orElse(null);
        return compareTrajectories(golden, actual, options, session);
    }

    public TrajectoryReport compareCassetteFrames(List<CassetteFrame> goldenFrames, List<CassetteFrame> actualFrames, CompareOptions options) {
        return compareCassetteFrames(goldenFrames, actualFrames, options, Set.of());
    }
}
