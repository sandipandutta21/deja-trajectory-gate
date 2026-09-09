package dev.deja.core.trajectory;

import dev.deja.core.cassette.JsonRpcMessage;
import dev.deja.core.match.Match;
import lombok.experimental.UtilityClass;

import java.util.Objects;

/** Mirrors the TypeScript implementation's {@code pairing.ts}. */
@UtilityClass
public class Pairing {

    /** @param accepted {@code score} clears {@code threshold} -- an "accepted" match, the primary alignment objective */
    public record PairScore(double score, MatchTier tier, boolean accepted) {
    }

    private JsonRpcMessage toMessage(TrajectoryStep step) {
        return JsonRpcMessage.request(null, step.method(), step.params());
    }

    /**
     * Scores a candidate golden/actual pair. Returns {@code null} when the pair
     * is ineligible to match at all -- different method, or (for {@code tools/call}) different
     * tool name -- reusing {@link Match#calculateSimilarity}'s own hard tool-identity gate (F3)
     * so that rule has exactly one implementation. An eligible pair always gets a score, even 0
     * (a hard content mismatch): a same-tool call with wildly different arguments is still more
     * informative paired up as "drifted" than reported as two disconnected added/missing steps.
     */
    public PairScore scorePair(TrajectoryStep golden, TrajectoryStep actual, double threshold) {
        if (!golden.method().equals(actual.method())) {
            return null;
        }
        if (!Objects.equals(golden.toolName(), actual.toolName())) {
            return null;
        }

        JsonRpcMessage a = toMessage(golden);
        JsonRpcMessage b = toMessage(actual);

        if (Match.matchStructural(a, b)) {
            return new PairScore(1, MatchTier.EXACT, true);
        }

        double score = Match.calculateSimilarity(a, b);
        return new PairScore(score, MatchTier.SEMANTIC, score >= threshold);
    }
}
