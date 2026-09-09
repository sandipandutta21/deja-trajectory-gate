package dev.deja.core.trajectory;

import lombok.experimental.UtilityClass;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Mirrors the TypeScript implementation's {@code alignment.ts}. */
@UtilityClass
public class Alignment {

    /** @param reordered set only by {@link #classifyReorders}: this pair was originally two
     *                   disconnected missing/added entries, merged because they'd have scored
     *                   an accepted match against each other. Distinguishes "the DP genuinely
     *                   matched this in place" from "these were relabeled after the fact" for
     *                   {@code Compare}'s classification step. */
    public record AlignedPair(Integer goldenIndex, Integer actualIndex, Double score, MatchTier tier, boolean reordered) {
        static AlignedPair matched(int goldenIndex, int actualIndex, double score, MatchTier tier) {
            return new AlignedPair(goldenIndex, actualIndex, score, tier, false);
        }

        static AlignedPair missing(int goldenIndex) {
            return new AlignedPair(goldenIndex, null, null, null, false);
        }

        static AlignedPair added(int actualIndex) {
            return new AlignedPair(null, actualIndex, null, null, false);
        }

        static AlignedPair reordered(int goldenIndex, int actualIndex, double score, MatchTier tier) {
            return new AlignedPair(goldenIndex, actualIndex, score, tier, true);
        }
    }

    /** Dominates any achievable sum of raw [0,1] scores at the "few hundred steps" scale this
     *  is built for -- so "maximize accepted matches" always outranks "maximize total score" in
     *  the scalarized objective, however the DP/assignment actually sums it. */
    private final double ACCEPTED_WEIGHT = 1e9;

    /** Per-operation cost, small enough never to outweigh a single unit of score, present only
     *  to break ties toward fewer insertions/deletions. */
    private final double INDEL_PENALTY = 1e-6;

    /** Nudges tied weights toward lower golden/actual index, small enough never to outweigh a
     *  real score difference at this scale. */
    private final double INDEX_TIEBREAK_EPSILON = 1e-9;

    private enum Move { MATCH, DELETE, INSERT }

    /**
     * Strict mode: ordered dynamic-programming sequence alignment. Every golden step
     * is either matched to exactly one actual step (in order) or reported missing; every actual
     * step is either matched or reported added. An eligible same-tool pair is always preferred
     * as a match -- even scored 0 -- over reporting it as a disconnected add+missing (see
     * {@link Pairing#scorePair}).
     */
    public List<AlignedPair> alignStrict(List<TrajectoryStep> golden, List<TrajectoryStep> actual, double threshold) {
        int n = golden.size();
        int m = actual.size();

        double[][] dp = new double[n + 1][m + 1];
        Move[][] choice = new Move[n + 1][m + 1];
        for (Move[] row : choice) {
            Arrays.fill(row, Move.DELETE);
        }

        for (int i = 1; i <= n; i++) {
            dp[i][0] = -i * INDEL_PENALTY;
        }
        for (int j = 1; j <= m; j++) {
            dp[0][j] = -j * INDEL_PENALTY;
        }

        for (int i = 1; i <= n; i++) {
            for (int j = 1; j <= m; j++) {
                double deleteValue = dp[i - 1][j] - INDEL_PENALTY;
                double insertValue = dp[i][j - 1] - INDEL_PENALTY;

                double best = deleteValue;
                Move bestMove = Move.DELETE;
                if (insertValue > best) {
                    best = insertValue;
                    bestMove = Move.INSERT;
                }

                TrajectoryStep goldenStep = golden.get(i - 1);
                TrajectoryStep actualStep = actual.get(j - 1);
                Pairing.PairScore pair = Pairing.scorePair(goldenStep, actualStep, threshold);
                if (pair != null) {
                    double matchValue = dp[i - 1][j - 1]
                            + (pair.accepted() ? ACCEPTED_WEIGHT : 0)
                            + pair.score()
                            - INDEX_TIEBREAK_EPSILON * (goldenStep.index() + actualStep.index());
                    // Tie-break: a match is always preferred to leaving both sides unaligned.
                    if (matchValue >= best) {
                        best = matchValue;
                        bestMove = Move.MATCH;
                    }
                }

                dp[i][j] = best;
                choice[i][j] = bestMove;
            }
        }

        List<AlignedPair> pairs = new ArrayList<>();
        int i = n;
        int j = m;
        while (i > 0 || j > 0) {
            Move move = i == 0 ? Move.INSERT : j == 0 ? Move.DELETE : choice[i][j];
            if (move == Move.MATCH) {
                Pairing.PairScore pair = Pairing.scorePair(golden.get(i - 1), actual.get(j - 1), threshold);
                pairs.add(AlignedPair.matched(golden.get(i - 1).index(), actual.get(j - 1).index(), pair.score(), pair.tier()));
                i--;
                j--;
            } else if (move == Move.DELETE) {
                pairs.add(AlignedPair.missing(golden.get(i - 1).index()));
                i--;
            } else {
                pairs.add(AlignedPair.added(actual.get(j - 1).index()));
                j--;
            }
        }

        Collections.reverse(pairs);
        return pairs;
    }

    private String groupKey(TrajectoryStep step) {
        return step.method() + "␟" + (step.toolName() == null ? "" : step.toolName());
    }

    /**
     * Unordered mode: deterministic maximum-weight bipartite assignment, the basis
     * subset/superset also compare against. Eligibility (same method, same tool name)
     * partitions steps into independent groups -- cross-group matches never happen -- so each
     * group is solved as its own small complete-bipartite assignment problem rather than one
     * global n*m matrix.
     */
    public List<AlignedPair> alignUnordered(List<TrajectoryStep> golden, List<TrajectoryStep> actual, double threshold) {
        Map<String, List<TrajectoryStep>> goldenGroups = new LinkedHashMap<>();
        Map<String, List<TrajectoryStep>> actualGroups = new LinkedHashMap<>();

        for (TrajectoryStep step : golden) {
            goldenGroups.computeIfAbsent(groupKey(step), k -> new ArrayList<>()).add(step);
        }
        for (TrajectoryStep step : actual) {
            actualGroups.computeIfAbsent(groupKey(step), k -> new ArrayList<>()).add(step);
        }

        List<AlignedPair> pairs = new ArrayList<>();
        Set<String> allKeys = new LinkedHashSet<>();
        allKeys.addAll(goldenGroups.keySet());
        allKeys.addAll(actualGroups.keySet());

        for (String key : allKeys) {
            List<TrajectoryStep> g = goldenGroups.getOrDefault(key, List.of());
            List<TrajectoryStep> a = actualGroups.getOrDefault(key, List.of());

            if (g.isEmpty()) {
                for (TrajectoryStep step : a) {
                    pairs.add(AlignedPair.added(step.index()));
                }
                continue;
            }
            if (a.isEmpty()) {
                for (TrajectoryStep step : g) {
                    pairs.add(AlignedPair.missing(step.index()));
                }
                continue;
            }

            // Hungarian requires rows <= cols; transpose when the golden side is larger.
            boolean transpose = g.size() > a.size();
            List<TrajectoryStep> rows = transpose ? a : g;
            List<TrajectoryStep> cols = transpose ? g : a;

            double[][] weights = new double[rows.size()][cols.size()];
            for (int r = 0; r < rows.size(); r++) {
                for (int c = 0; c < cols.size(); c++) {
                    TrajectoryStep goldenStep = transpose ? cols.get(c) : rows.get(r);
                    TrajectoryStep actualStep = transpose ? rows.get(r) : cols.get(c);
                    Pairing.PairScore pair = Pairing.scorePair(goldenStep, actualStep, threshold); // eligible by construction
                    weights[r][c] = (pair.accepted() ? ACCEPTED_WEIGHT : 0) + pair.score()
                            - INDEX_TIEBREAK_EPSILON * (goldenStep.index() + actualStep.index());
                }
            }

            int[] assignment = Hungarian.maxWeightAssignment(weights);
            Set<Integer> matchedCols = new HashSet<>();

            for (int r = 0; r < assignment.length; r++) {
                int c = assignment[r];
                matchedCols.add(c);
                TrajectoryStep goldenStep = transpose ? cols.get(c) : rows.get(r);
                TrajectoryStep actualStep = transpose ? rows.get(r) : cols.get(c);
                Pairing.PairScore pair = Pairing.scorePair(goldenStep, actualStep, threshold);
                pairs.add(AlignedPair.matched(goldenStep.index(), actualStep.index(), pair.score(), pair.tier()));
            }

            for (int c = 0; c < cols.size(); c++) {
                if (matchedCols.contains(c)) {
                    continue;
                }
                TrajectoryStep step = cols.get(c);
                pairs.add(transpose ? AlignedPair.missing(step.index()) : AlignedPair.added(step.index()));
            }
        }

        pairs.sort((x, y) -> {
            int gx = x.goldenIndex() == null ? Integer.MAX_VALUE : x.goldenIndex();
            int gy = y.goldenIndex() == null ? Integer.MAX_VALUE : y.goldenIndex();
            if (gx != gy) {
                return Integer.compare(gx, gy);
            }
            int ax = x.actualIndex() == null ? Integer.MAX_VALUE : x.actualIndex();
            int ay = y.actualIndex() == null ? Integer.MAX_VALUE : y.actualIndex();
            return Integer.compare(ax, ay);
        });

        return pairs;
    }

    /**
     * Post-processes a strict-mode alignment: a {@code missing} golden step and an {@code
     * added} actual step that would have scored an accepted match against each other are
     * relabeled from two disconnected entries into one {@code reordered} entry -- diagnostic
     * only. {@code reordered} is still a failure in strict mode; this never changes what passes
     * or fails, only how it reads.
     *
     * <p>Grouped by (method, toolName) exactly like {@link #alignUnordered}, since a merge can
     * only ever be eligible within one group anyway; each group is its own small assignment
     * problem so a missing step is never merged with more than one added step, or vice versa.
     */
    public List<AlignedPair> classifyReorders(List<AlignedPair> pairs, List<TrajectoryStep> golden, List<TrajectoryStep> actual, double threshold) {
        List<Integer> missingPositions = new ArrayList<>();
        List<Integer> addedPositions = new ArrayList<>();
        for (int position = 0; position < pairs.size(); position++) {
            AlignedPair pair = pairs.get(position);
            if (pair.goldenIndex() != null && pair.actualIndex() == null) {
                missingPositions.add(position);
            }
            if (pair.actualIndex() != null && pair.goldenIndex() == null) {
                addedPositions.add(position);
            }
        }
        if (missingPositions.isEmpty() || addedPositions.isEmpty()) {
            return pairs;
        }

        Map<String, List<Integer>> missingByGroup = new LinkedHashMap<>();
        for (int position : missingPositions) {
            String key = groupKey(golden.get(pairs.get(position).goldenIndex()));
            missingByGroup.computeIfAbsent(key, k -> new ArrayList<>()).add(position);
        }
        Map<String, List<Integer>> addedByGroup = new LinkedHashMap<>();
        for (int position : addedPositions) {
            String key = groupKey(actual.get(pairs.get(position).actualIndex()));
            addedByGroup.computeIfAbsent(key, k -> new ArrayList<>()).add(position);
        }

        Map<Integer, Integer> mergePartner = new HashMap<>();

        for (var entry : missingByGroup.entrySet()) {
            List<Integer> addedPosList = addedByGroup.get(entry.getKey());
            if (addedPosList == null) {
                continue;
            }
            List<Integer> missingPosList = entry.getValue();

            boolean transpose = missingPosList.size() > addedPosList.size();
            List<Integer> rows = transpose ? addedPosList : missingPosList;
            List<Integer> cols = transpose ? missingPosList : addedPosList;

            double[][] weights = new double[rows.size()][cols.size()];
            for (int r = 0; r < rows.size(); r++) {
                for (int c = 0; c < cols.size(); c++) {
                    int missingPos = transpose ? cols.get(c) : rows.get(r);
                    int addedPos = transpose ? rows.get(r) : cols.get(c);
                    Pairing.PairScore pair = Pairing.scorePair(
                            golden.get(pairs.get(missingPos).goldenIndex()), actual.get(pairs.get(addedPos).actualIndex()), threshold);
                    weights[r][c] = (pair.accepted() ? ACCEPTED_WEIGHT : 0) + pair.score();
                }
            }

            int[] assignment = Hungarian.maxWeightAssignment(weights);
            for (int r = 0; r < assignment.length; r++) {
                int c = assignment[r];
                int missingPos = transpose ? cols.get(c) : rows.get(r);
                int addedPos = transpose ? rows.get(r) : cols.get(c);
                Pairing.PairScore pair = Pairing.scorePair(
                        golden.get(pairs.get(missingPos).goldenIndex()), actual.get(pairs.get(addedPos).actualIndex()), threshold);
                // Only an accepted (score >= threshold) pair reads as "clearly the same call,
                // just moved" -- otherwise this would misleadingly merge two calls to the same
                // tool that just happen to share a group, not a genuine reorder.
                if (pair.accepted()) {
                    mergePartner.put(missingPos, addedPos);
                    mergePartner.put(addedPos, missingPos);
                }
            }
        }

        if (mergePartner.isEmpty()) {
            return pairs;
        }

        List<AlignedPair> result = new ArrayList<>();
        Set<Integer> emitted = new HashSet<>();
        for (int position = 0; position < pairs.size(); position++) {
            if (emitted.contains(position)) {
                continue;
            }

            Integer partner = mergePartner.get(position);
            if (partner == null) {
                result.add(pairs.get(position));
                continue;
            }

            emitted.add(position);
            emitted.add(partner);
            int missingPos = pairs.get(position).goldenIndex() != null ? position : partner;
            int addedPos = pairs.get(position).actualIndex() != null ? position : partner;
            TrajectoryStep goldenStep = golden.get(pairs.get(missingPos).goldenIndex());
            TrajectoryStep actualStep = actual.get(pairs.get(addedPos).actualIndex());
            Pairing.PairScore scored = Pairing.scorePair(goldenStep, actualStep, threshold);
            result.add(AlignedPair.reordered(goldenStep.index(), actualStep.index(), scored.score(), scored.tier()));
        }

        return result;
    }
}
