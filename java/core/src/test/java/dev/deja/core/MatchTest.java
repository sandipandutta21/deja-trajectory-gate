package dev.deja.core;

import dev.deja.core.cassette.JsonRpcMessage;
import dev.deja.core.match.JudgeVerdict;
import dev.deja.core.match.Match;
import dev.deja.core.match.SemanticJudge;
import dev.deja.core.match.SemanticMatchOptions;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;

import static org.assertj.core.api.Assertions.assertThat;

class MatchTest {

    private JsonRpcMessage toolCall(Object id, String tool, Map<String, Object> extraParams) {
        Map<String, Object> params = new java.util.LinkedHashMap<>();
        params.put("name", tool);
        params.putAll(extraParams);
        return JsonRpcMessage.request(id, "tools/call", params);
    }

    // --- Matching Tier ---

    @Test
    void matchesIdenticalStructuresWhileIgnoringIds() {
        JsonRpcMessage incoming = toolCall(100, "test", Map.of());
        JsonRpcMessage recorded = toolCall(1, "test", Map.of());
        assertThat(Match.matchStructural(incoming, recorded)).isTrue();
    }

    @Test
    void ignoresMcpMetaParameters() {
        JsonRpcMessage incoming = toolCall(2, "test", Map.of("_meta", Map.of("progressToken", "123")));
        JsonRpcMessage recorded = toolCall(1, "test", Map.of());
        assertThat(Match.matchStructural(incoming, recorded)).isTrue();
    }

    @Test
    void normalizesEmptyParams() {
        JsonRpcMessage incoming = JsonRpcMessage.request(2, "resources/list", Map.of());
        JsonRpcMessage recorded = JsonRpcMessage.request(1, "resources/list", null);
        assertThat(Match.matchStructural(incoming, recorded)).isTrue();
    }

    @Test
    void failsStructuralMatchOnDifferentData() {
        JsonRpcMessage incoming = toolCall(2, "fetch", Map.of());
        JsonRpcMessage recorded = toolCall(1, "echo", Map.of());
        assertThat(Match.matchStructural(incoming, recorded)).isFalse();
    }

    @Test
    void isTolerantOfKeyOrder() {
        Map<String, Object> argsA = new java.util.LinkedHashMap<>();
        argsA.put("b", 2);
        argsA.put("a", 1);
        JsonRpcMessage incoming = toolCall(1, "fetch", Map.of("args", argsA));

        Map<String, Object> argsB = new java.util.LinkedHashMap<>();
        argsB.put("a", 1);
        argsB.put("b", 2);
        JsonRpcMessage recorded = toolCall(2, "fetch", Map.of("args", argsB));

        assertThat(Match.matchStructural(incoming, recorded)).isTrue();
    }

    // --- Hard safety gate ---

    @Test
    void neverMatchesToolsCallAcrossDifferentToolNamesEvenStructurallyClose() {
        JsonRpcMessage incoming = toolCall(1, "delete_file", Map.of("path", "/tmp/x"));
        JsonRpcMessage recorded = toolCall(2, "read_file", Map.of("path", "/tmp/x"));

        assertThat(Match.matchStructural(incoming, recorded)).isFalse();
        assertThat(Match.calculateSimilarity(incoming, recorded)).isZero();
    }

    @Test
    void neverMatchesAcrossDifferentMethods() {
        JsonRpcMessage incoming = JsonRpcMessage.request(1, "resources/list", null);
        JsonRpcMessage recorded = JsonRpcMessage.request(2, "tools/list", null);
        assertThat(Match.calculateSimilarity(incoming, recorded)).isZero();
    }

    @Test
    void neverFuzzyMatchesTwoDifferentPathsSharingALongLiteralPrefix() {
        // Regression test: found via real-server testing (TypeScript side) against the MCP
        // filesystem reference server. Two different files under the same long directory
        // prefix scored deceptively high on generic character/word similarity before this
        // gate existed, risking one file's content being confidently returned for a request
        // naming a different file.
        JsonRpcMessage incoming = toolCall(1, "read_text_file", Map.of("path", "/home/user/projects/deja/data/other.txt"));
        JsonRpcMessage recorded = toolCall(2, "read_text_file", Map.of("path", "/home/user/projects/deja/data/config.txt"));

        assertThat(Match.calculateSimilarity(incoming, recorded)).isZero();
    }

    @Test
    void gatesConservativelyOnAnySlashContainingStringEvenOrdinaryProse() {
        // The heuristic can't distinguish "this slash means a path" from "this slash means
        // prose", so it deliberately requires exact equality for any slash-containing value.
        JsonRpcMessage incoming = toolCall(1, "echo", Map.of("message", "yes/no answer please"));
        JsonRpcMessage recorded = toolCall(2, "echo", Map.of("message", "yes/no answer, please"));

        assertThat(Match.calculateSimilarity(incoming, recorded)).isZero();
    }

    @Test
    void stillFuzzyMatchesNearIdenticalProseWithNoPathLikeSeparators() {
        JsonRpcMessage incoming = toolCall(1, "echo", Map.of("message", "please say hello"));
        JsonRpcMessage recorded = toolCall(2, "echo", Map.of("message", "please say hellO"));

        assertThat(Match.calculateSimilarity(incoming, recorded)).isGreaterThan(0);
    }

    @Test
    void doesNotGateOnPathsThatAreIdentical() {
        JsonRpcMessage incoming = toolCall(1, "read_text_file", Map.of("path", "/a/b/c.txt", "extra", "x"));
        JsonRpcMessage recorded = toolCall(2, "read_text_file", Map.of("path", "/a/b/c.txt"));

        assertThat(Match.calculateSimilarity(incoming, recorded)).isGreaterThan(0);
    }

    // --- Semantic similarity primitives ---

    @Test
    void numericClosenessIsOneForEqualNumbersAndDecaysWithRelativeDistance() {
        assertThat(Match.numericCloseness(5, 5)).isEqualTo(1);
        assertThat(Match.numericCloseness(100, 101)).isGreaterThan(0.9);
        assertThat(Match.numericCloseness(1, 1000)).isLessThan(0.1);
    }

    @Test
    void trigramDiceIsOneForIdenticalStringsAndZeroForWhollyDissimilarOnes() {
        assertThat(Match.trigramDice("hello", "hello")).isEqualTo(1);
        assertThat(Match.trigramDice("hello world", "hxllo worlx")).isGreaterThan(0.5);
        assertThat(Match.trigramDice("abc", "xyz")).isZero();
    }

    @Test
    void tokenJaccardIgnoresTokenOrderAndRewardsOverlap() {
        assertThat(Match.tokenJaccard("fetch the url", "the url fetch")).isEqualTo(1);
        assertThat(Match.tokenJaccard("alpha beta", "gamma delta")).isZero();
    }

    // --- calculateSimilarity (semantic tier) ---

    @Test
    void returnsOneForAStructuralMatch() {
        JsonRpcMessage incoming = toolCall(1, "search", Map.of("query", "best pizza"));
        JsonRpcMessage recorded = toolCall(2, "search", Map.of("query", "best pizza"));
        assertThat(Match.calculateSimilarity(incoming, recorded)).isEqualTo(1);
    }

    @Test
    void scoresNearIdenticalParamsHighlyButNotIdentically() {
        JsonRpcMessage incoming = toolCall(1, "search", Map.of("query", "best pizza near me"));
        JsonRpcMessage recorded = toolCall(2, "search", Map.of("query", "best pizza near mee"));

        double score = Match.calculateSimilarity(incoming, recorded);
        assertThat(score).isGreaterThan(0.75).isLessThan(1);
    }

    @Test
    void scoresWildlyDifferentParamsLow() {
        JsonRpcMessage incoming = toolCall(1, "search", Map.of("query", "aaaaaaaaaa"));
        JsonRpcMessage recorded = toolCall(2, "search", Map.of("query", "zzzzzzzzzz completely unrelated"));
        assertThat(Match.calculateSimilarity(incoming, recorded)).isLessThan(0.5);
    }

    @Test
    void penalizesAMissingKeyRatherThanIgnoringIt() {
        JsonRpcMessage incoming = toolCall(1, "search", Map.of("query", "x", "extra", "y"));
        JsonRpcMessage recorded = toolCall(2, "search", Map.of("query", "x"));
        assertThat(Match.calculateSimilarity(incoming, recorded)).isLessThan(1);
    }

    // --- findSemanticMatch ---

    private record Candidate(String id, JsonRpcMessage msg) {
    }

    private <T> T await(CompletableFuture<T> future) {
        try {
            return future.get();
        } catch (InterruptedException | ExecutionException e) {
            throw new RuntimeException(e);
        }
    }

    @Test
    void returnsTheHighestScoringCandidateAtOrAboveThreshold() {
        JsonRpcMessage incoming = toolCall(1, "search", Map.of("query", "best pizza near me"));
        List<Candidate> candidates = List.of(
                new Candidate("close", toolCall(2, "search", Map.of("query", "best pizza near mee"))),
                new Candidate("far", toolCall(3, "search", Map.of("query", "completely unrelated topic"))));

        SemanticMatchOptions<Candidate> options = SemanticMatchOptions.<Candidate>builder()
                .candidates(candidates)
                .messageExtractor(Candidate::msg)
                .threshold(0.75)
                .build();

        Optional<Candidate> match = await(Match.findSemanticMatch(incoming, options));
        assertThat(match).isPresent();
        assertThat(match.get().id()).isEqualTo("close");
    }

    @Test
    void returnsEmptyWhenNothingClearsTheThresholdAndThereIsNoJudge() {
        JsonRpcMessage incoming = toolCall(1, "search", Map.of("query", "alpha"));
        List<Candidate> candidates = List.of(
                new Candidate("far", toolCall(2, "search", Map.of("query", "completely different topic entirely"))));

        SemanticMatchOptions<Candidate> options = SemanticMatchOptions.<Candidate>builder()
                .candidates(candidates)
                .messageExtractor(Candidate::msg)
                .threshold(0.9)
                .build();

        assertThat(await(Match.findSemanticMatch(incoming, options))).isEmpty();
    }

    @Test
    void escalatesOnlyTheUncertainBandToTheJudgeNotEverythingBelowThreshold() {
        JsonRpcMessage incoming = toolCall(1, "search", Map.of("query", "best pizza near me"));
        Candidate uncertain = new Candidate("uncertain", toolCall(2, "search", Map.of("query", "best pizza near m")));
        Candidate hopeless = new Candidate("hopeless", toolCall(3, "search", Map.of("query", "completely unrelated topic")));

        List<JsonRpcMessage> judged = new java.util.ArrayList<>();
        SemanticJudge judge = (inc, recorded) -> {
            judged.add(recorded);
            return CompletableFuture.completedFuture(new JudgeVerdict(true));
        };

        SemanticMatchOptions<Candidate> options = SemanticMatchOptions.<Candidate>builder()
                .candidates(List.of(uncertain, hopeless))
                .messageExtractor(Candidate::msg)
                .threshold(0.95)
                .judge(judge)
                .build();

        Optional<Candidate> match = await(Match.findSemanticMatch(incoming, options));
        assertThat(match).isPresent();
        assertThat(match.get().id()).isEqualTo("uncertain");
        // The "hopeless" candidate's score is far below threshold - 0.15, so it must never
        // reach the judge.
        assertThat(judged).hasSize(1);
    }

    @Test
    void neverLetsAJudgeApproveAMatchAcrossDifferentToolNames() {
        JsonRpcMessage incoming = toolCall(1, "delete_file", Map.of("path", "/x"));
        Candidate wrongTool = new Candidate("wrong-tool", toolCall(2, "read_file", Map.of("path", "/x")));

        SemanticJudge judge = (inc, recorded) -> CompletableFuture.completedFuture(new JudgeVerdict(true));

        SemanticMatchOptions<Candidate> options = SemanticMatchOptions.<Candidate>builder()
                .candidates(List.of(wrongTool))
                .messageExtractor(Candidate::msg)
                .threshold(0.5)
                .judge(judge)
                .build();

        assertThat(await(Match.findSemanticMatch(incoming, options))).isEmpty();
    }

    @Test
    void failsClosedWhenTwoDifferentCandidatesTieForTheTopQualifyingScore() {
        JsonRpcMessage incoming = toolCall(1, "search", Map.of("query", "best pizza near me"));
        // Two distinct candidates with byte-identical message content score identically against
        // any given incoming message -- a guaranteed, reproducible tie, not a contrived mock.
        JsonRpcMessage tiedMsg = toolCall(2, "search", Map.of("query", "best pizza near mee"));
        List<Candidate> candidates = List.of(new Candidate("first", tiedMsg), new Candidate("second", tiedMsg));

        SemanticMatchOptions<Candidate> options = SemanticMatchOptions.<Candidate>builder()
                .candidates(candidates)
                .messageExtractor(Candidate::msg)
                .threshold(0.75)
                .build();

        assertThat(await(Match.findSemanticMatch(incoming, options))).isEmpty();
    }

    @Test
    void stillReturnsTheSoleWinnerWhenOnlyOneCandidateTiesItself() {
        JsonRpcMessage incoming = toolCall(1, "search", Map.of("query", "best pizza near me"));
        List<Candidate> candidates = List.of(
                new Candidate("close", toolCall(2, "search", Map.of("query", "best pizza near mee"))),
                new Candidate("far", toolCall(3, "search", Map.of("query", "completely unrelated topic"))));

        SemanticMatchOptions<Candidate> options = SemanticMatchOptions.<Candidate>builder()
                .candidates(candidates)
                .messageExtractor(Candidate::msg)
                .threshold(0.75)
                .build();

        Optional<Candidate> match = await(Match.findSemanticMatch(incoming, options));
        assertThat(match).isPresent();
        assertThat(match.get().id()).isEqualTo("close");
    }
}
